// Headless serve host: when `dom serve` runs WITHOUT a TTY (no TUI), this keeps the
// server alive with a real tabs controller + engines that the browser drives. It
// mirrors the same transcript items to the event bus that the TUI's App does, so
// the browser view is identical whether or not a terminal is attached — and so the
// `dom serve` command is reachable/verifiable the way a user actually runs it.

import path from "node:path";
import { rankedFiles } from "./filesearch.js";
import { Engine, type Callbacks } from "./engine.js";
import { TabsController, type Tab } from "./tabs.js";
import type { AppBridge } from "./events.js";
import { partitionAttachments } from "./messages.js";
import { fetchModels, parseModelCommand, buildModelPickItems, switchPriceNote } from "./models.js";
import { listSessions, loadSession, domDir, saveConfig } from "./config.js";
import { saveVaultNote } from "./vault.js";
import { callParts, resultBody, toolDetail } from "./ui/toolrender.js";

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
      const summary = resultBody({ isError: result.isError, verbose: false, name: call.name, args, output: result.output });
      const detail = toolDetail(call.name, args, result.output);
      bus.emit({ type: "tool.end", tabId: id, tool, primary, secondary, ok: !result.isError, summary, detail });
    },
    onSystem: (text) => bus.emit({ type: "line", tabId: id, item: { kind: "system", text } }),
    onTurnCost: () => {}, // controller emits turn.end
    // No local UI to answer — the browser answers via the bridge. The engine's
    // permission wrapper already registered the pending request + emitted
    // permission.request; this promise simply never resolves on its own.
    requestPermission: () => new Promise(() => {}),
  };
}

// Overlay id counter for headless-armed selection pickers (model/session).
let overlaySeq = 0;

/** Arm a selection overlay for the browser. Headless serve has no TUI Picker, so
 * the browser is the only client — but it uses the SAME bridge registry + events
 * the TUI does, so the wire contract (and the web modal) is identical. `pick` runs
 * on select; a null answer is a cancel. Answering is one-shot. */
function openOverlay(bridge: AppBridge, tabId: number, kind: string, title: string, items: { value: string; label: string }[], selected: string | null, pick: (v: string) => void): void {
  const id = `overlay:${tabId}:${++overlaySeq}`;
  let done = false;
  bridge.registerOverlay(id, (v) => {
    if (done) return;
    done = true;
    bridge.clearOverlay(id);
    bridge.bus.emit({ type: "overlay.resolved", id });
    if (v !== null) pick(v);
  });
  bridge.bus.emit({ type: "overlay.open", tabId, id, kind, title, items, selected });
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
    case "model": {
      // Same parsing as the TUI, so `--save` works here too and in any position.
      // Previously this took parts[1] verbatim, which meant `/model --save <id>`
      // tried to switch to a model literally named "--save".
      const { save, model } = parseModelCommand(parts.slice(1).join(" "));
      if (save && !model) {
        void saveConfig({ model: tab.engine.modelId }).then(() => say(`switched to ${tab.engine.modelId} (saved as default)`));
        break;
      }
      if (model) {
        tab.engine.setModel(model);
        void tab.engine.persist();
        // Confirm the price alongside the id. fetchModels is memoised, so this
        // costs nothing after the first call.
        void fetchModels().then((all) => {
          const note = switchPriceNote(all.find((m) => m.id === model));
          if (save) void saveConfig({ model }).then(() => say(`switched to ${model} (saved as default)${note}`));
          else say(`switched to ${model}${note}`);
        });
        break;
      }
      void fetchModels().then((models) => {
        // Price + context window travel with each row: headless serve has no TUI
        // picker, so the browser overlay is the ONLY place these are ever shown.
        const items = buildModelPickItems(models);
        openOverlay(bridge, tab.id, "model", "select model", items, tab.engine.modelId, (v) => {
          tab.engine.setModel(v);
          void tab.engine.persist();
          say(`switched to ${v}${switchPriceNote(models.find((m) => m.id === v))}`);
        });
      });
      break;
    }
    case "resume":
      // Open the session picker for THIS directory (newest-first list); selecting
      // one adopts it into the live engine.
      void listSessions().then((all) => {
        const here = all.filter((s) => s.cwd === tab.engine.cwd && s.id !== tab.engine.sessionId());
        if (!here.length) { say(all.length ? "no prior sessions for this directory" : "no saved sessions"); return; }
        const items = here.map((s) => ({ value: s.id, label: `${s.id} · ${s.messages.length} msgs · ${s.model}` }));
        openOverlay(bridge, tab.id, "session", "resume session", items, null, (id) => {
          void loadSession(id).then((s) => {
            if (!s) { say(`could not load session ${id}`); return; }
            tab.engine.adoptSession(s);
            say(`resumed ${id} (${s.messages.length} messages)`);
          });
        });
      });
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

/** Wire the controller + bridge so the server can answer a browser: the agent
 * roster, input/command routing, file search, vault saves. Returns as soon as the
 * wiring is in place.
 *
 * This is split out of runServeHeadless because ORDER MATTERS at startup. The
 * server begins listening (and `dom serve` prints its URL) before this runs, so
 * until the bridge is wired `bridge.getAgents()` is still the default empty stub —
 * and a browser connecting in that window receives a snapshot with no agents in
 * it. Call this BEFORE advertising the URL. */
export function wireServeHost(rootEngine: Engine, bridge: AppBridge): void {
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
    controller.tabs.map((t) => ({ id: t.id, name: t.name, cwd: t.engine.cwd, model: t.engine.modelId, mode: t.engine.mode, busy: t.busy, imageInput: t.engine.supportsImageInput(), documentInput: t.engine.supportsDocumentInput(), contextLimit: t.engine.contextLength(), tokens: t.engine.cost.promptTokens + t.engine.cost.completionTokens, cost: t.engine.cost.usd }));
  bridge.getSkills = () => rootEngine.skills.map((s) => ({ name: s.name, description: s.description, scope: s.scope }));
  bridge.onInput = (tabId, text, attachments) => {
    const tab = controller.byId(tabId) ?? controller.active();
    let finalText = text;
    if (attachments?.length) {
      const { images, files, inlineText } = partitionAttachments(attachments);
      if (images.length) tab.engine.setNextUserImages(images);
      if (files.length) tab.engine.setNextUserFiles(files);
      if (inlineText) finalText = finalText ? `${finalText}\n\n${inlineText}` : inlineText;
    }
    // Show the typed text (or an attachment note) in the transcript, not the raw inlined bytes.
    const shown = text || (attachments?.length ? `[${attachments.length} attachment(s)]` : "");
    bridge.bus.emit({ type: "line", tabId: tab.id, item: { kind: "user", text: shown } });
    controller.submitUser(tab, finalText);
  };
  bridge.onCommand = (tabId, command) => handleCommand(controller, tabId, command, bridge);
  bridge.onCreateAgent = (name, purpose) => void controller.create(name, purpose);
  bridge.onCloseAgent = (tabId) => void controller.close(tabId);
  // Stop the running turn without closing the tab — the browser's only way to
  // interrupt an agent (headless serve has no TUI Esc).
  bridge.onStopAgent = (tabId) => {
    const t = controller.byId(tabId);
    if (!t) return;
    t.engine.abort();
    t.pendingPermission?.resolve("no");
    bridge.bus.emit({ type: "line", tabId: t.id, item: { kind: "system", text: "⎩ stopped by the user" } });
  };
  bridge.onFiles = (tabId, query) => rankedFiles((controller.byId(tabId) ?? controller.active()).engine.cwd, query);
  bridge.onVaultSave = async (filename, tags, content) => {
    const r = await saveVaultNote(filename, tags, content);
    if (r.ok) bridge.bus.emit({ type: "vault.changed" });
    return r;
  };

}

/** Wire the host, then stay alive. The returned promise never resolves (the
 * process runs until Ctrl+C). */
export function runServeHeadless(rootEngine: Engine, bridge: AppBridge): Promise<void> {
  wireServeHost(rootEngine, bridge);
  return new Promise<void>(() => {}); // keep the process alive
}
