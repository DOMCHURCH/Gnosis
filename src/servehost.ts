// Headless serve host: when `dom serve` runs WITHOUT a TTY (no TUI), this keeps the
// server alive with a real tabs controller + engines that the browser drives. It
// mirrors the same transcript items to the event bus that the TUI's App does, so
// the browser view is identical whether or not a terminal is attached — and so the
// `dom serve` command is reachable/verifiable the way a user actually runs it.
//
// The Electron app runs through here too (electron/main.js boots the same engine
// and points a window at the same URL), which makes this file the whole of the
// difference between "in the terminal" and "in the app". It used to implement six
// slash commands out of the forty-five the bridge ADVERTISES to the browser — so
// the app's autocomplete offered /vault, /skills, /context, /memory, /undo and the
// rest, and every one of them answered "attach a terminal for the full command
// set". That is what "stripped down in the app" was: not a weaker engine — the
// engine, the tools, the system prompt and the reasoning loop are literally the
// same objects — but a command surface that stopped at the door.
//
// So the command set below is the TUI's, minus only what has no meaning without a
// terminal (/exit quits a process the window owns; /alltabs and /verbose are
// terminal rendering modes the browser already does better). Those few say what
// the browser equivalent IS rather than telling the user to go somewhere else.

import path from "node:path";
import { existsSync } from "node:fs";
import { rankedFiles } from "./filesearch.js";
import { Engine, outcomeLine, type Callbacks } from "./engine.js";
import { TabsController, type Tab } from "./tabs.js";
import type { AppBridge } from "./events.js";
import { partitionAttachments, contextBreakdown } from "./messages.js";
import { fetchModels, parseModelCommand, buildModelPickItems, switchPriceNote, resolveModelQuery } from "./models.js";
import { listSessions, loadSession, domDir, loadConfig, saveConfig, resolveVaultPath, type Mode } from "./config.js";
import { saveVaultNote } from "./vault.js";
import { callParts, resultBody, toolDetail } from "./ui/toolrender.js";
import { helpText } from "./commands.js";
import { TOOL_NAMES } from "./tools/index.js";
import { scanFile, SECURITY_IGNORE_FILE } from "./security.js";
import { readMemory, appendMemory, clearMemory, countEntries, memoryPath } from "./memory.js";
import { buildLearnedContext, learnedStats, clearSessionMemory } from "./sessionmemory.js";
import { addSchedule, removeSchedule, loadSchedules, nextRunAt } from "./schedule.js";
import { readTrace, summarizeTrace, formatTraceSummary } from "./trace.js";
import { undoLast, listCheckpoints } from "./checkpoint.js";
import { undoLastDomCommit } from "./autocommit.js";
import { jobs } from "./jobs.js";
import { listHooks } from "./hooks.js";
import { writeAgentsMd } from "./init.js";
import { buildRepoMap } from "./repomap.js";
import { webhooks } from "./webhooks.js";
import { createWorktree, listWorktrees, mergeWorktree, removeWorktree, slug as worktreeSlug } from "./worktree.js";
import { resolveDesignUrl } from "./design.js";
import { captureScreenshot } from "./screenshot.js";
import { recentTurns, applyRewind, applySummary, splitForSummary, summaryPrompt } from "./rewind.js";

/** Build bus-mirroring callbacks for a tab's turn (no terminal rendering). The
 * engine itself already emits tool.start + permission.request; the controller
 * emits busy/turn/created/mode. Here we mirror transcript lines + tool results. */
function mirrorCallbacks(tab: Tab, bridge: AppBridge): Callbacks {
  const bus = bridge.bus;
  const id = tab.id;
  let lastPartial = 0;
  return {
    onLine: (l) =>
      bus.emit({ type: "line", tabId: id, item: l.kind === "rule" ? { kind: "rule", lang: l.lang } : { kind: "line", text: l.text } }),
    // The in-flight line, throttled. Voice speaks at sentence boundaries and
    // `line` only fires on a newline, so without this the first spoken word waits
    // for the whole paragraph. Whole-value each time: no reassembly downstream.
    onPending: (text) => {
      const now = Date.now();
      if (text && now - lastPartial < 120) return;
      lastPartial = now;
      bus.emit({ type: "line.partial", tabId: id, text });
    },
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

/** A stub Callbacks for engine work that has no turn behind it (compaction).
 * Lines still reach the browser; there is nobody to ask, so nothing prompts. */
function busCallbacks(tab: Tab, bridge: AppBridge): Callbacks {
  return {
    ...mirrorCallbacks(tab, bridge),
    requestPermission: async () => "no",
  };
}

/**
 * The slash commands, for a client with no terminal attached.
 *
 * Every command the bridge advertises (src/commands.ts — the SAME list the TUI's
 * /help renders from) is answered here, because advertising a command and then
 * refusing it is worse than not offering it at all.
 *
 * Three do not survive the trip and say so specifically rather than generically:
 * /exit would kill the process the window is drawn by, /alltabs is a terminal
 * tiling mode the browser's floor view already is, and /verbose is a rendering
 * toggle — the browser ships the full tool output in every tool.end and expands
 * it on click, so it is already "on".
 */
async function handleCommand(controller: TabsController, tabId: number, command: string, bridge: AppBridge): Promise<void> {
  const tab = controller.byId(tabId) ?? controller.active();
  const engine = tab.engine;
  const parts = command.replace(/^\//, "").trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  const say = (text: string) => bridge.bus.emit({ type: "line", tabId: tab.id, item: { kind: "system", text } });
  const rel = (p: string) => path.relative(engine.cwd, p).split(path.sep).join("/") || path.basename(p);

  switch (cmd) {
    case "help":
      say(helpText());
      break;

    case "tools":
      say("tools: " + TOOL_NAMES.join(", "));
      break;

    case "skills": {
      const sk = engine.skills;
      if (!sk.length) {
        say("no skills loaded — add SKILL.md under ~/.dom/skills/<name>/ (or ./.dom/skills/<name>/)");
        break;
      }
      say([`skills (${sk.length} loaded):`, ...sk.map((s) => `  ${s.name}${s.scope === "project" ? " [project]" : ""}  —  ${s.description}`)].join("\n"));
      break;
    }

    case "mode": {
      const toks = arg.split(/\s+/).filter(Boolean);
      const save = toks.includes("--save") || toks.includes("-s");
      const m = toks.find((t) => t === "ask" || t === "plan" || t === "yolo") as Mode | undefined;
      if (!m) { say("usage: /mode <ask|plan|yolo> [--save]"); break; }
      engine.setMode(m);
      await engine.persist();
      if (save) await saveConfig({ mode: m });
      say(`mode → ${m}${save ? "  (saved as default)" : ""}`);
      break;
    }

    // /approve (plan mode): switch to ask and execute the written plan. The plan is
    // the model's last assistant message; it's fed back so execution is grounded in it.
    case "approve": {
      if (engine.mode !== "plan") { say("/approve only applies in plan mode"); break; }
      const plan = [...engine.messages].reverse().find((m) => m.role === "assistant" && !!m.text);
      engine.setMode("ask");
      void engine.persist();
      say("plan approved — switching to ask mode and executing");
      const text = plan && "text" in plan && plan.text ? `The plan is approved. Implement it now:\n\n${plan.text}` : "The plan is approved. Implement it now.";
      controller.submitUser(tab, text);
      break;
    }

    case "revise": {
      if (engine.mode !== "plan") { say("/revise only applies in plan mode"); break; }
      if (!arg.trim()) { say("usage: /revise <what to change>"); break; }
      say(`revising the plan: ${arg}`);
      controller.submitUser(tab, `Please revise the plan: ${arg}`);
      break;
    }

    case "new":
      say(`new agent ${controller.create(parts[1], parts.slice(2).join(" ")).name}`);
      break;

    case "tabs": {
      const rows = controller.tabs.map((t, i) => `  ${i + 1}. ${t.name}${t.id === tab.id ? "  (this one)" : ""}  ${t.engine.cwd}${t.busy ? "  · busy" : ""}`);
      say([`agents (${controller.tabs.length}):`, ...rows].join("\n"));
      break;
    }

    case "tab": {
      // The browser owns which agent is on screen (it is a click, not a command),
      // so this resolves the name/number and says which one it means rather than
      // pretending to switch something it does not control.
      if (!arg) { say("usage: /tab <number|name>"); break; }
      const n = Number(arg);
      const t = Number.isInteger(n) && n > 0 ? controller.tabs[n - 1] : controller.byName(arg);
      say(t ? `that is “${t.name}” — select it in the sidebar (the browser owns which agent is on screen)` : `no agent ${arg}`);
      break;
    }

    case "close":
      if (controller.tabs.length <= 1) { say("can't close the last agent"); break; }
      controller.close(tab.id);
      say(`closed ${tab.name}`);
      break;

    case "alltabs":
      say("the floor view already shows every agent at once — that is what /alltabs is for in the terminal");
      break;

    case "verbose":
      say("tool output is already full here: every result is sent whole and the browser expands it on click");
      break;

    case "exit":
    case "quit":
      say("/exit quits the terminal session. Close the window (or the tray icon) to quit the app.");
      break;

    case "serve":
      say("already serving — this IS the served UI. Use /serve from a terminal session to start another.");
      break;

    case "worktree":
    case "wt": {
      const wargs = parts.slice(1);
      const sub = (wargs[0] ?? "").toLowerCase();
      if (!sub || sub === "list") {
        const list = await listWorktrees(engine.cwd);
        say(list.length
          ? ["worktrees:", ...list.map((w) => `  ${w.name}  → ${w.branch}  ${w.path}`)].join("\n")
          : "no dom worktrees. `/worktree <name>` opens one in an isolated branch + agent.");
        break;
      }
      if (sub === "merge") {
        const name = wargs[1];
        if (!name) { say("usage: /worktree merge <name>"); break; }
        say(`⟳ merging worktree ${worktreeSlug(name)}…`);
        const r = await mergeWorktree(engine.cwd, name);
        say(r.ok ? `✓ merged dom/${worktreeSlug(name)} into the current branch` : `✗ merge failed: ${r.error}`);
        break;
      }
      if (sub === "remove" || sub === "rm") {
        const name = wargs[1];
        if (!name) { say("usage: /worktree remove <name> [--force]"); break; }
        const r = await removeWorktree(engine.cwd, name, { force: wargs.includes("--force") || wargs.includes("-f"), deleteBranch: true });
        say(r.ok ? `✓ removed worktree ${worktreeSlug(name)} (branch deleted)` : `✗ ${r.error}`);
        break;
      }
      const name = wargs.join(" ");
      say(`⟳ creating worktree ${worktreeSlug(name)}…`);
      const r = await createWorktree(engine.cwd, name);
      if (!r.ok) { say(`✗ ${r.error}`); break; }
      controller.create(r.info.name, `worktree ${r.info.branch}`, r.info.path);
      say(`✓ worktree ${r.info.name} on ${r.info.branch} — isolated at ${r.info.path}.\n` +
        `  Edits here don't touch your working tree. \`/worktree merge ${r.info.name}\` brings it back; \`/worktree remove ${r.info.name}\` discards it.`);
      break;
    }

    case "workspace":
    case "ws": {
      const sub = (parts[1] ?? "").toLowerCase();
      if (!sub || sub === "list") {
        const rows = engine.roots.map((r, i) => `  ${i === 0 ? "*" : "-"} ${r}${i === 0 ? "  (primary)" : ""}`);
        say([`workspace roots (${engine.roots.length}) — grep/glob without a path search all:`, ...rows].join("\n"));
      } else if (sub === "add" || sub === "remove" || sub === "rm") {
        const p = parts.slice(2).join(" ");
        if (!p) { say(`usage: /workspace ${sub} <path>`); break; }
        const r = sub === "add" ? engine.addRoot(p) : engine.removeRoot(p);
        say(r.ok ? `✓ ${sub === "add" ? "added" : "removed"} workspace root: ${r.message}` : `✗ ${r.message}`);
      } else {
        say("usage: /workspace [list | add <path> | remove <path>]");
      }
      break;
    }

    case "memory":
    case "mem": {
      const sub = (parts[1] ?? "").toLowerCase();
      if (sub === "clear") {
        await Promise.all([clearMemory(engine.cwd), clearSessionMemory()]);
        bridge.bus.emit({ type: "connections.changed" });
        say("memory: manual bank + automatic learned context cleared.");
      } else if (sub === "add") {
        const note = parts.slice(2).join(" ");
        if (!note) { say("usage: /memory add <note>"); break; }
        const n = await appendMemory(engine.cwd, note);
        say(`✓ memory: saved (${n} note${n === 1 ? "" : "s"}).`);
      } else if (sub === "show") {
        say((await buildLearnedContext()) || "memory: no automatic learned context yet — it builds after sessions that touch files.");
      } else if (sub === "stats") {
        const s = await learnedStats();
        say(`memory: ${s.sessions} session${s.sessions === 1 ? "" : "s"} recorded · ${s.files} file${s.files === 1 ? "" : "s"} tracked · oldest ${s.oldest ?? "—"}`);
      } else {
        const c = await readMemory(engine.cwd);
        say(c
          ? `memory (${countEntries(c)} notes) — ${memoryPath(engine.cwd)}:\n${c}\n(also: /memory show learned context · /memory stats · /memory clear)`
          : "memory: manual bank empty. The model saves notes with the memory tool; /memory add <note> adds one. Automatic learned context: /memory show · /memory stats · /memory clear.");
      }
      break;
    }

    case "schedule":
    case "sched": {
      const sub = (parts[1] ?? "list").toLowerCase();
      if (sub === "add") {
        const rest = parts.slice(2).join(" ");
        const bar = rest.indexOf("|");
        const spec = (bar >= 0 ? rest.slice(0, bar) : "").trim();
        const prompt = (bar >= 0 ? rest.slice(bar + 1) : "").trim();
        if (!spec || !prompt) { say("usage: /schedule add <spec> | <prompt>   e.g. /schedule add every 1h | check the build"); break; }
        const r = await addSchedule({ spec, prompt, cwd: engine.cwd }, Date.now(), Math.floor(Math.random() * 1e6).toString(36));
        say(r.ok
          ? `✓ scheduled ${r.schedule.id}: ${r.schedule.spec} — next ${new Date(nextRunAt(r.schedule, Date.now()) ?? Date.now()).toLocaleString()}. Fires via \`dom schedule tick\`.`
          : `✗ ${r.error}`);
      } else if (sub === "remove" || sub === "rm") {
        const id = parts[2];
        if (!id) { say("usage: /schedule remove <id>"); break; }
        say((await removeSchedule(id)) ? `✓ removed ${id}` : `no schedule ${id}`);
      } else {
        const all = await loadSchedules();
        if (!all.length) { say("no scheduled runs. /schedule add <spec> | <prompt>. A cron entry / `gnosis schedule tick` fires due ones."); break; }
        const now = Date.now();
        say([`scheduled runs (${all.length}):`, ...all.map((s) =>
          `  ${s.id} [${s.enabled ? "on" : "off"}] ${s.spec} — ${s.prompt}\n     next ${new Date(nextRunAt(s, now) ?? now).toLocaleString()}${s.lastStatus ? `  · last ${s.lastStatus}` : ""}`)].join("\n"));
      }
      break;
    }

    case "security": {
      if (parts[1] !== "scan" || !parts[2]) { say("usage: /security scan <path>"); break; }
      const target = path.resolve(engine.cwd, parts.slice(2).join(" "));
      try {
        const res = await scanFile(target, engine.cwd);
        if (res.exempt) say(`${rel(target)}: exempt via ${SECURITY_IGNORE_FILE}`);
        else if (!res.findings.length) say(`${rel(target)}: clean — no secrets detected`);
        // Only the redacted sample is ever printed.
        else say([`${rel(target)}: ${res.findings.length} finding(s)`, ...res.findings.map((f) => `  line ${f.line}: ${f.kind} (${f.sample})`)].join("\n"));
      } catch (e) {
        say(`security: ${(e as Error).message}`);
      }
      break;
    }

    case "commit": {
      if (!engine.blockedCommits.size) { say("nothing blocked — auto-commit is up to date"); break; }
      if (!(parts.includes("--force") || parts.includes("-f"))) {
        say([`${engine.blockedCommits.size} file(s) blocked by the security scan:`,
          ...[...engine.blockedCommits.keys()].map((abs) => `  ${rel(abs)}`),
          "  /commit --force commits them anyway"].join("\n"));
        break;
      }
      const done = await engine.forceBlockedCommits();
      say(done.length ? `committed ${done.length} file(s) despite the security scan: ${done.join(", ")}` : "nothing to commit");
      break;
    }

    case "cost": {
      const cached = engine.cost.cachedPromptTokens ?? 0;
      const uncached = Math.max(0, engine.cost.promptTokens - cached);
      const sub = engine.cost.subAgentUsd ?? 0;
      const oracle = engine.cost.oracleUsd ?? 0;
      const runs = engine.cost.subAgents ?? [];
      const extras: string[] = [];
      if (sub > 0) extras.push(`$${sub.toFixed(4)} sub-agents`);
      if (oracle > 0) extras.push(`$${oracle.toFixed(4)} oracle`);
      say(`in: ${uncached} uncached + ${cached} cached · out: ${engine.cost.completionTokens} · $${engine.cost.usd.toFixed(4)}` +
        (extras.length ? ` (incl. ${extras.join(", ")})` : ""));
      if (runs.length) {
        const coordinator = Math.max(0, engine.cost.usd - sub - oracle);
        say([`coordinator: $${coordinator.toFixed(4)}`, ...runs.map((r, i) => `sub-agent-${i + 1} (${r.label}): $${r.usd.toFixed(4)}`)].join(", "));
      }
      break;
    }

    case "budget": {
      if (arg) {
        const n = Number(arg);
        if (n > 0) { engine.budgetUsd = n; engine.budgetCeiling = n; say(`budget ceiling set to $${n.toFixed(2)}`); }
        else say("usage: /budget <usd>");
      } else {
        const ceil = engine.budgetCeiling === Infinity ? "∞" : `$${engine.budgetCeiling.toFixed(2)}`;
        say(`budget: $${engine.cost.usd.toFixed(4)} spent / ${ceil} ceiling`);
      }
      break;
    }

    case "context": {
      const cats = contextBreakdown(engine.messages, engine.currentSystemPrompt(), engine.summary).sort((a, b) => b.tokens - a.tokens);
      const total = cats.reduce((s, c) => s + c.tokens, 0);
      const win = engine.contextLength();
      const rows = cats.map((c) => {
        const pctUsed = total ? Math.round((c.tokens / total) * 100) : 0;
        const pctWin = win ? ((c.tokens / win) * 100).toFixed(1) : null;
        return `  ${c.name.padEnd(15)} ${String(c.tokens).padStart(7)}  ${String(pctUsed).padStart(3)}% of used${pctWin ? `  ${pctWin}% of window` : ""}`;
      });
      say([win ? `context: ${total} tokens used / ${win} window (${Math.round((total / win) * 100)}% full)` : `context: ${total} tokens used`, ...rows].join("\n"));
      break;
    }

    case "trace": {
      const sid = engine.sessionId();
      const events = await readTrace(sid);
      say(events.length
        ? formatTraceSummary(sid, summarizeTrace(events))
        : "no trace yet for this session (traces are written per model/tool call to ~/.dom/traces)");
      break;
    }

    case "verify":
    case "eval": {
      say("⟳ evaluating the last turn…");
      try {
        const v = await engine.runVerifier();
        if (!v) { say("nothing to evaluate (no file edits in the last turn, or no diff)"); break; }
        say(outcomeLine(v));
        if (v.verdict === "fail") say("  /fix feeds this critique back as the next turn");
      } catch (e) {
        say(`eval: ${(e as Error).message}`);
      }
      break;
    }

    case "fix": {
      const p = engine.takeOutcomeFix();
      if (!p) { say("nothing to fix — no failed outcome on the last turn"); break; }
      bridge.bus.emit({ type: "line", tabId: tab.id, item: { kind: "user", text: p } });
      controller.submitUser(tab, p);
      break;
    }

    case "clear":
      engine.clear();
      say("conversation cleared");
      break;

    case "compact":
      engine.forceCompact(busCallbacks(tab, bridge));
      break;

    case "rewind": {
      // Two overlays, exactly as the TUI does it: pick a turn, then pick what to
      // do with it. Same bridge registry, so this is the same modal the browser
      // already renders for /model — no second UI, and no guessing on the user's
      // behalf between "drop this" and "compress everything before this".
      const marks = recentTurns(engine.messages, 20);
      if (!marks.length) { say("nothing to rewind to — no turns in this session yet"); break; }
      const items = [...marks].reverse().map((m) => ({ value: String(m.index), label: `${String(m.number).padStart(3)}. ${m.summary}` }));
      openOverlay(bridge, tab.id, "rewind", "rewind — pick a turn", items, null, (v) => {
        const mark = marks.find((m) => String(m.index) === v);
        if (!mark) return;
        const actions = [
          { value: "rewind", label: `rewind to here — drop turn ${mark.number} and everything after` },
          { value: "summarize", label: `summarize up to here — compress turns 1-${mark.number - 1}, keep the rest verbatim` },
        ];
        openOverlay(bridge, tab.id, "rewind-action", `turn ${mark.number}: ${mark.summary}`, actions, null, (choice) => {
          if (choice === "rewind") {
            const r = applyRewind(engine.messages, mark);
            // Mutate in place: the engine holds this array, and reassigning would
            // leave it pointing at the old history.
            engine.messages.length = 0;
            engine.messages.push(...r.messages);
            void engine.persist();
            say(`↶ ${r.note}`);
            return;
          }
          const { head } = splitForSummary(engine.messages, mark.index);
          if (!head.length) { say("nothing before that turn to summarize"); return; }
          say(`⟳ summarizing ${head.length} message(s) with the oracle model…`);
          // The oracle model is the stronger one — a bad summary here silently
          // poisons every turn that follows, so it is worth the better model.
          void engine
            .runOracle(summaryPrompt(head))
            .then((res) => {
              const r = applySummary(engine.messages, mark, res.text);
              engine.messages.length = 0;
              engine.messages.push(...r.messages);
              void engine.persist();
              say(`⟳ ${r.note}`);
            })
            .catch((e: unknown) => say(`summarize failed: ${(e as Error).message}`));
        });
      });
      break;
    }

    case "model": {
      // Same parsing as the TUI, so `--save` works here too and in any position.
      const { save, model } = parseModelCommand(parts.slice(1).join(" "));
      if (save && !model) {
        await saveConfig({ model: engine.modelId });
        say(`switched to ${engine.modelId} (saved as default)`);
        break;
      }
      if (model) {
        const all = await fetchModels();
        // Resolve a partial id the way the TUI does, so `/model sonnet` works in
        // both. A query that matches several opens the picker over just those,
        // rather than picking one and hoping.
        const apply = async (id: string) => {
          engine.setModel(id);
          await engine.persist();
          const note = switchPriceNote(all.find((m) => m.id === id));
          if (save) { await saveConfig({ model: id }); say(`switched to ${id} (saved as default)${note}`); }
          else say(`switched to ${id}${note}`);
        };
        const hit = resolveModelQuery(all, model);
        if (hit.kind === "exact") { await apply(hit.id); break; }
        if (hit.kind === "none") { say(`no model matches "${model}"`); break; }
        const matched = all.filter((m) => hit.ids.includes(m.id));
        openOverlay(bridge, tab.id, "model", save ? "select model (will save as default)" : "select model",
          buildModelPickItems(matched), hit.ids[0] ?? null, (v) => void apply(v));
        break;
      }
      const models = await fetchModels();
      // Price + context window travel with each row: this overlay is the ONLY
      // place they are ever shown without a terminal.
      openOverlay(bridge, tab.id, "model", "select model", buildModelPickItems(models), engine.modelId, (v) => {
        engine.setModel(v);
        void engine.persist();
        say(`switched to ${v}${switchPriceNote(models.find((m) => m.id === v))}`);
      });
      break;
    }

    case "resume": {
      // The session picker for THIS directory (newest-first); selecting one adopts
      // it into the live engine.
      const all = await listSessions();
      const here = all.filter((s) => s.cwd === engine.cwd && s.id !== engine.sessionId());
      if (!here.length) { say(all.length ? "no prior sessions for this directory" : "no saved sessions"); break; }
      const items = here.map((s) => ({ value: s.id, label: `${s.id} · ${s.messages.length} msgs · ${s.model}` }));
      openOverlay(bridge, tab.id, "session", "resume session", items, null, (id) => {
        void loadSession(id).then((s) => {
          if (!s) { say(`could not load session ${id}`); return; }
          engine.adoptSession(s);
          say(`resumed ${id} (${s.messages.length} messages)`);
        });
      });
      break;
    }

    case "vault": {
      // resolveVaultPath, not config.obsidianVault: a `vault:` line in
      // ~/.dom/AGENTS.md configures one too, and reading only the config key made
      // /vault answer "none configured" on a machine that plainly had one.
      if (parts[1]?.toLowerCase() === "set") {
        const p = parts.slice(2).join(" ");
        if (!p) { say("usage: /vault set <path>"); break; }
        const abs = path.resolve(p);
        if (!existsSync(abs)) { say(`vault path does not exist: ${abs}`); break; }
        await saveConfig({ obsidianVault: abs }); // read-merges: other keys survive
        engine.cwd = abs;
        say(`vault → ${abs}`);
        break;
      }
      if (arg) { say("usage: /vault  or  /vault set <path>"); break; }
      const vault = await resolveVaultPath(await loadConfig());
      if (!vault) { say("no obsidian vault configured — set one with /vault set <path>"); break; }
      if (!existsSync(vault)) { say(`vault path does not exist: ${vault}`); break; }
      engine.cwd = vault;
      say(`vault → ${vault}`);
      break;
    }

    case "undo": {
      // Prefer reverting the last dom auto-commit; fall back to the checkpoint ref
      // (used when auto-commit is off or the change was never committed).
      const undone = await undoLastDomCommit(engine.cwd);
      if (undone) { say(`reverted last Gnosis commit — ${undone.message}`); break; }
      const reverted = await undoLast(engine.cwd);
      say(reverted ? `reverted ${reverted}` : "nothing to undo");
      break;
    }

    case "checkpoints": {
      const cps = await listCheckpoints(engine.cwd);
      say(cps.length ? ["checkpoints (newest first):", ...cps.map((c) => `  ${c.iso}  ${c.tool}  ${c.rel}`)].join("\n") : "no checkpoints");
      break;
    }

    case "init": {
      const r = await writeAgentsMd(engine.cwd, parts[1] === "--force" || parts[1] === "-f");
      say(r.written
        ? `wrote ${rel(r.path)} (${r.lineCount} lines) — it's appended to the system prompt next session`
        : r.reason ?? "could not write AGENTS.md");
      break;
    }

    case "map": {
      const budget = (await loadConfig()).mapTokens ?? 1024;
      const m = await buildRepoMap(engine.cwd, budget);
      say(m.text
        ? `${m.text}\n\n(${m.tokens} tokens · budget ${budget} · ${m.files} files, ${m.parsed} parsed / ${m.cached} cached)`
        : "repo map is empty (no supported source files, or no grammar installed)");
      break;
    }

    case "hooks": {
      const hs = await listHooks(engine.cwd);
      say(hs.length
        ? ["hooks:", ...hs.map((h) => `  ${h.event} [${h.scope}]  ${h.path}`)].join("\n")
        : "no hooks registered — add scripts under ~/.dom/hooks/ or ./.dom/hooks/ (SessionStart, PreToolUse, PostToolUse, Stop)");
      break;
    }

    case "jobs": {
      const all = jobs.list();
      if (!all.length) { say("no background jobs"); break; }
      say(["background jobs:", ...all.map((j) => {
        const secs = Math.floor((Date.now() - j.startedAt) / 1000);
        const st = j.status === "running" ? `running ${secs}s` : j.status === "error" ? `exit ${j.exitCode}` : j.status;
        return `  ${j.id}. [${st}] ${j.command}`;
      })].join("\n"));
      break;
    }

    case "job": {
      if (!arg) { say("usage: /job <id>"); break; }
      const out = jobs.output(arg);
      if (out === null) { say(`no job ${arg}`); break; }
      const j = jobs.get(arg);
      say(`job ${arg} (${j?.status ?? "?"}) — ${j?.command ?? ""}\n${out}`);
      break;
    }

    case "kill": {
      if (!arg) { say("usage: /kill <id>"); break; }
      const j = jobs.get(arg);
      if (!j) { say(`no job ${arg}`); break; }
      if (j.status !== "running") { say(`job ${arg} is already ${j.status}`); break; }
      jobs.kill(arg);
      say(`killed job ${arg}: ${j.command}`);
      break;
    }

    case "webhooks":
    case "webhook": {
      if (arg.trim().toLowerCase() === "clear") { webhooks.clear(); say("webhooks: buffer cleared"); break; }
      const list = webhooks.list();
      say(list.length
        ? [`webhooks (${list.length}):`, ...list.slice(0, 20).map((w) => `  ${w.method} /webhook/${w.label} · ${w.size}B · ${w.id}`)].join("\n")
        : "webhooks: none received yet. POST to /webhook/<label>?token=… (see the WEBHOOKS tab).");
      break;
    }

    case "design": {
      if (arg.trim().toLowerCase() === "off") { engine.designMode = null; say("design: off."); break; }
      const ports = jobs.list().filter((j) => j.port != null).map((j) => j.port as number);
      const res = resolveDesignUrl(arg, ports);
      if (res.error || !res.url) { say(`design: ${res.error}`); break; }
      say(`design: capturing ${res.url}…`);
      const shot = await captureScreenshot(res.url);
      if (!shot.ok || !shot.data || !shot.mime) { say(`design: ${shot.error}`); break; }
      const dataUrl = `data:${shot.mime};base64,${shot.data}`;
      engine.designMode = { url: res.url, lastShot: dataUrl };
      engine.addNextUserImage({ source: `design:${res.url}`, mime: shot.mime, data: shot.data });
      if (!engine.supportsImageInput()) say("design: note — the active model has no vision input, so it can't see the screenshot.");
      say(`design: on for ${res.url}. Screenshot attached to your next message; edits to web files will auto-capture before/after.`);
      bridge.bus.emit({ type: "design.shot", tabId: tab.id, path: "", before: null, after: dataUrl });
      break;
    }

    default:
      say(`unknown command: /${cmd} (try /help)`);
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
    controller.tabs.map((t) => ({ id: t.id, name: t.name, cwd: t.engine.cwd, model: t.engine.modelId, mode: t.engine.mode, busy: t.busy, imageInput: t.engine.supportsImageInput(), documentInput: t.engine.supportsDocumentInput(), contextLimit: t.engine.contextLength(), contextUsed: t.engine.contextTokens(), tokens: t.engine.cost.promptTokens + t.engine.cost.completionTokens, cost: t.engine.cost.usd }));
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
