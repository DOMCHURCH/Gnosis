// Headless serve host: when `dom serve` runs WITHOUT a TTY (no TUI), this keeps the
// server alive with a real tabs controller + engines that the browser drives. It
// mirrors the same transcript items to the event bus that the TUI's App does, so
// the browser view is identical whether or not a terminal is attached — and so the
// `dom serve` command is reachable/verifiable the way a user actually runs it.

import path from "node:path";
import { Engine, type Callbacks } from "./engine.js";
import { TabsController, type Tab } from "./tabs.js";
import type { AppBridge } from "./events.js";
import { callParts, resultBody } from "./ui/toolrender.js";

/** Build bus-mirroring callbacks for a tab's turn (no terminal rendering). The
 * engine itself already emits tool.start + permission.request; the controller
 * emits busy/turn/created/mode. Here we mirror transcript lines + tool results. */
function mirrorCallbacks(tab: Tab, bridge: AppBridge): Callbacks {
  const bus = bridge.bus;
  const id = tab.id;
  return {
    onLine: (l) =>
      bus.emit({ type: "line", tabId: id, item: l.kind === "rule" ? { kind: "rule", lang: l.lang } : { kind: "line", text: l.text } }),
    onPending: () => {},
    onAssistant: () => {},
    onToolStart: () => {}, // engine emits tool.start
    onToolResult: (call, result) => {
      let args: unknown = {};
      try {
        args = call.args ? JSON.parse(call.args) : {};
      } catch {
        /* keep {} */
      }
      const { tool, primary, secondary } = callParts(call.name, args as Record<string, unknown>);
      const body = resultBody({ isError: result.isError, verbose: false, name: call.name, args, output: result.output });
      bus.emit({ type: "tool.end", tabId: id, tool, primary, secondary, ok: !result.isError, summary: body });
    },
    onSystem: (text) => bus.emit({ type: "line", tabId: id, item: { kind: "system", text } }),
    onTurnCost: () => {}, // controller emits turn.end
    // No local UI to answer — the browser answers via the bridge. The engine's
    // permission wrapper already registered the pending request + emitted
    // permission.request; this promise simply never resolves on its own.
    requestPermission: () => new Promise(() => {}),
  };
}

/** A minimal slash-command handler for headless serve (the TUI has the full set). */
function handleCommand(controller: TabsController, tabId: number, command: string, bridge: AppBridge): void {
  const tab = controller.byId(tabId) ?? controller.active();
  const parts = command.replace(/^\//, "").trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const say = (text: string) => bridge.bus.emit({ type: "line", tabId: tab.id, item: { kind: "system", text } });
  switch (cmd) {
    case "mode": {
      const m = parts[1];
      if (m === "ask" || m === "plan" || m === "yolo") { tab.engine.setMode(m); say(`mode → ${m}`); } else say("usage: /mode <ask|plan|yolo>");
      break;
    }
    case "new":
      say(`new agent ${controller.create(parts[1]).name}`);
      break;
    case "model":
      if (parts[1]) { tab.engine.setModel(parts[1]); say(`model → ${parts[1]}`); } else say(`model: ${tab.engine.modelId}`);
      break;
    case "cost": {
      const c = tab.engine.cost;
      say(`$${c.usd.toFixed(4)} · ${c.promptTokens} in · ${c.completionTokens} out`);
      break;
    }
    case "clear":
      tab.engine.clear();
      say("conversation cleared");
      break;
    default:
      say(`(${command}) isn't available in headless serve — attach a terminal for the full command set`);
  }
}

/** Run the server headlessly: wire the controller + bridge, then stay alive. The
 * returned promise never resolves (the process runs until Ctrl+C). */
export function runServeHeadless(rootEngine: Engine, bridge: AppBridge): Promise<void> {
  rootEngine.interactive = true; // file edits prompt → answered from the browser
  const rootName = path.basename(rootEngine.cwd) || "main";
  const controller = new TabsController(
    rootEngine,
    rootName,
    (tab, text) => tab.engine.run(text, mirrorCallbacks(tab, bridge)),
    () => {},
    bridge.bus,
    bridge,
  );

  bridge.getAgents = () =>
    controller.tabs.map((t) => ({ id: t.id, name: t.name, cwd: t.engine.cwd, model: t.engine.modelId, mode: t.engine.mode, busy: t.busy }));
  bridge.onInput = (tabId, text) => {
    const tab = controller.byId(tabId) ?? controller.active();
    bridge.bus.emit({ type: "line", tabId: tab.id, item: { kind: "user", text } });
    controller.submitUser(tab, text);
  };
  bridge.onCommand = (tabId, command) => handleCommand(controller, tabId, command, bridge);
  bridge.onCreateAgent = (name, purpose) => void controller.create(name, purpose);
  bridge.onCloseAgent = (tabId) => void controller.close(tabId);

  return new Promise<void>(() => {}); // keep the process alive
}
