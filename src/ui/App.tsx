import { useEffect, useRef, useState, type ReactNode } from "react";
import { existsSync } from "node:fs";
import path from "node:path";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { Banner } from "./Banner.js";
import { StatusBar } from "./StatusBar.js";
import { TabBar } from "./TabBar.js";
import { SPINNER_FRAMES, ASCII_SPINNER, pickWord, formatElapsed } from "./thinking.js";
import { cycleApprovalMode } from "./modes.js";
import { InputBar } from "./InputBar.js";
import { Permission } from "./Permission.js";
import { Picker, type PickItem } from "./Picker.js";
import { C } from "./theme.js";
import { callParts, callLine, resultLines, resultBody } from "./toolrender.js";
import { AllTabs } from "./AllTabsView.js";
import { layoutAllTabs, gridColumns } from "./alltabs.js";
import type { Caps } from "./terminal.js";
import { Engine, type Callbacks } from "../engine.js";
import { TabsController, type Tab } from "../tabs.js";
import type { Preview, PermissionAnswer } from "../permissions.js";
import { TOOL_NAMES } from "../tools/index.js";
import { runGlob } from "../tools/glob.js";
import { fetchModels, resolveModelQuery, type ModelEntry } from "../models.js";
import { getRepoInfo } from "../gitinfo.js";
import { undoLast, listCheckpoints } from "../checkpoint.js";
import { listSessions, loadConfig, loadSession, saveConfig, type Mode } from "../config.js";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

type Log =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "line"; text: string }
  | { id: number; kind: "rule"; lang: string }
  | { id: number; kind: "tool"; tool: string; primary: string; secondary: string; ok: boolean; body: string }
  | { id: number; kind: "system"; text: string };

type Overlay =
  | { type: "none" }
  | { type: "permission"; preview: Preview }
  | { type: "model"; items: PickItem[]; initial?: string; save?: boolean }
  | { type: "file"; items: PickItem[]; prefix: string }
  | { type: "session"; items: PickItem[] };

interface Props {
  engine: Engine;
  caps: Caps;
  width: number;
  ghAuth: string;
  initialRepo: { branch: string | null; dirtyCount: number };
  /** Non-fatal skill-loading warnings, shown dim at the top of the transcript. */
  skillWarnings: string[];
  /** Configured default model (config.model ?? built-in). The status bar marks a
   * divergence when the live session model differs from this. */
  defaultModel: string;
}

const HELP = [
  "commands:",
  "  /model [id]   switch model (no arg opens the picker)",
  "  /mode <ask|plan|yolo>   change permission mode",
  "  /new [name] [purpose]   open a new tab (its own history + engine)",
  "  /tabs         list open tabs    /tab <n|name>  switch tabs    /close  close the active tab",
  "  /alltabs      tiled read-only overview of every tab (again, or /tab, exits)",
  "  /skills       list loaded skills",
  "  /clear        clear the conversation",
  "  /compact      summarize and shrink history",
  "  /tools        list available tools",
  "  /cost         show token + dollar usage",
  "  /verbose      toggle full (unsummarized) tool output",
  "  /resume       resume a past session",
  "  /vault [set <path>]   switch working root to your Obsidian vault",
  "  /undo         revert dom's most recent file edit",
  "  /checkpoints  list recent dom checkpoints",
  "  /help         this help    /exit  quit",
  "  @  insert a file path    !cmd  run a shell command",
  "  ctrl+1..9  best-effort tab-switch alias for /tab (some terminals don't send it)",
].join("\n");

// Per-1M-token price, from OpenRouter's per-token figures.
function priceLabel(m: ModelEntry): string {
  const per1M = (n: number) => (n * 1e6).toFixed(2);
  return `$${per1M(m.pricing.prompt)}/$${per1M(m.pricing.completion)} per 1M in/out`;
}

function priceHint(m: ModelEntry): string {
  return `—  ${priceLabel(m)}`;
}

function buildModelItems(models: ModelEntry[]): PickItem[] {
  return models.map((m) => ({
    value: m.id,
    label: m.id,
    hint: priceHint(m),
    // Typing in the picker narrows by id or name substring.
    search: `${m.id} ${m.name}`,
  }));
}

// Live terminal width, re-measured on SIGWINCH (terminal resize). Every element
// in the dynamic region is sized from this so borders/rows never reach the last
// column — reaching it makes the terminal auto-wrap a line Ink counts as one
// row, so its cursor-up erase comes up short and orphans a row per repaint.
function useTermWidth(fallback: number, regionRowsRef: { current: number }): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || fallback);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      // Clear the previous dynamic region BEFORE re-rendering at the new width.
      // Ink erases by logical line count, which under-counts once the terminal
      // reflows the old (wider) rows — stranding the old status bar + input box,
      // one per intermediate width. eraseDown (\x1b[J) is width-agnostic: move the
      // cursor up over the region's tracked height, then clear to end of screen.
      // Falls back to a bare eraseDown when the height isn't known.
      const rows = regionRowsRef.current;
      stdout.write(rows > 0 ? `\r\x1b[${rows}A\x1b[J` : "\x1b[J");
      setCols(stdout.columns || fallback);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, fallback, regionRowsRef]);
  return cols;
}

export function App({ engine: rootEngine, caps, width, ghAuth, initialRepo, skillWarnings, defaultModel }: Props) {
  const { exit } = useApp();
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  // Rows the dynamic region occupied at the last render — read by the resize
  // handler to erase the stale frame before re-rendering (see useTermWidth).
  const regionRowsRef = useRef(0);
  // The width every dynamic-region element is bounded by: two columns short of
  // the live terminal width, so nothing can touch the last column and wrap.
  const cols = useTermWidth(width, regionRowsRef);
  const inner = Math.max(24, cols - 2);

  const idRef = useRef(1);
  const nextId = () => idRef.current++;

  // The single append-only transcript stream rendered in <Static>. Each tab keeps
  // its OWN buffer of lines; only the active tab's lines are flushed here as they
  // arrive. Switching tabs flushes that tab's un-shown backlog (see switchToTab).
  const [screen, setScreen] = useState<Log[]>(() => {
    const seed: Log[] = [{ id: 0, kind: "banner" }];
    for (const w of skillWarnings) seed.push({ id: idRef.current++, kind: "system", text: `! ${w}` });
    return seed;
  });
  // Per-tab transcript buffers + how many of each are already on screen.
  type Buf = { log: Log[]; shown: number };
  const buffers = useRef<Map<number, Buf>>(new Map());
  const tabBuf = (id: number): Buf => {
    let b = buffers.current.get(id);
    if (!b) {
      b = { log: [], shown: 0 };
      buffers.current.set(id, b);
    }
    return b;
  };
  // Bumped to remount <Static> so it re-emits from scratch (a full-screen switch /
  // split-view toggle clears the terminal, then rebuilds the transcript).
  const [screenKey, setScreenKey] = useState(0);
  const { stdout } = useStdout();

  const [input, setInput] = useState("");
  // The transient in-progress line (streaming owner commits finished lines to the
  // transcript; this holds only the line still being typed — active tab only).
  const [pending, setPending] = useState("");
  const [liveTool, setLiveTool] = useState<string | null>(null);
  // /verbose: show full (unsummarized) tool output for the rest of the session.
  const [verbose, setVerbose] = useState(false);
  const verboseRef = useRef(false);
  verboseRef.current = verbose;
  // Boot goes straight to the prompt on the configured default model — no startup
  // picker. `/model` opens the picker on demand.
  const [overlay, setOverlay] = useState<Overlay>({ type: "none" });
  // The configured default model. `/model` switches the SESSION only; only an
  // explicit save (`/model --save`, or ctrl+s in the picker) rewrites this + config.
  // The status bar shows a dim `*` whenever the active model differs from it.
  const [savedModel, setSavedModel] = useState(defaultModel);
  const [repo, setRepo] = useState(initialRepo);
  // The working root (== process.cwd()) of the active tab; /vault and tab switches move it.
  const [root, setRoot] = useState(rootEngine.cwd);
  // Bumped by the tabs controller (onChange) so busy/badge/tab-bar state repaints.
  const [, setTabTick] = useState(0);
  // /alltabs split view: a read-only tiled overview of every tab replaces the
  // single-tab transcript. Input still routes to the active tab; any /tab switch
  // (or /alltabs again) exits back to single view.
  const [alt, setAlt] = useState(false);
  const altRef = useRef(false);
  altRef.current = alt;

  const busyRef = useRef(false);
  const inputRef = useRef("");
  inputRef.current = input;
  const overlayRef = useRef<Overlay>(overlay);
  overlayRef.current = overlay;
  // The live permission request: its resolver, preview, and which tab owns it (so a
  // switch can re-park an unanswered prompt onto its tab instead of dropping it).
  const permResolveRef = useRef<((a: PermissionAnswer) => void) | null>(null);
  const permPreviewRef = useRef<Preview | null>(null);
  const permOwnerRef = useRef<number | null>(null);
  // Latest fetched catalog, for pricing lookups when confirming a switch.
  const modelsRef = useRef<ModelEntry[]>(rootEngine.models);
  // Indirection so the controller (built once) always calls the latest closures.
  const executorRef = useRef<(tab: Tab, text: string) => Promise<void>>(async () => {});
  const onChangeRef = useRef<() => void>(() => {});

  // The tabs controller owns every tab's Engine, the active tab, and inter-agent
  // messaging with loop prevention. Built once; the root engine becomes tab 1.
  const controllerRef = useRef<TabsController | null>(null);
  if (!controllerRef.current) {
    const rootName = path.basename(rootEngine.cwd) || "main";
    controllerRef.current = new TabsController(
      rootEngine,
      rootName,
      (tab, text) => executorRef.current(tab, text),
      () => onChangeRef.current(),
    );
    tabBuf(controllerRef.current.active().id);
  }
  const controller = controllerRef.current;

  // Everything below acts on the ACTIVE tab's engine — commands, status bar, and
  // the busy/spinner all follow focus.
  const activeTab = controller.active();
  const engine = activeTab.engine;
  const busy = activeTab.busy;
  busyRef.current = busy;

  const isActive = (tab: Tab) => controller.active().id === tab.id;

  // Thinking spinner: a random playful word + live timer for the current turn.
  const frames = caps.legacy ? ASCII_SPINNER : SPINNER_FRAMES;
  const [think, setThink] = useState<{ word: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [spin, setSpin] = useState(0);
  // Bumped whenever the approval mode changes so the input hint re-renders.
  const [, setModeTick] = useState(0);

  // Ctrl+C is a two-step exit. The first press aborts the turn / clears state and
  // arms a 2-second window; a second press inside that window hard-exits (130).
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCArmedRef = useRef(false);
  ctrlCArmedRef.current = ctrlCArmed;
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armCtrlCExit = () => {
    ctrlCArmedRef.current = true;
    setCtrlCArmed(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => {
      ctrlCArmedRef.current = false;
      setCtrlCArmed(false);
      ctrlCTimer.current = null;
    }, 2000);
  };

  const hardExit = () => {
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* stdin isn't a TTY */
    }
    process.exit(130);
  };

  useEffect(() => () => clearTimeout(ctrlCTimer.current ?? undefined), []);

  const refreshRepo = () => {
    getRepoInfo(process.cwd()).then(setRepo).catch(() => {});
  };

  useEffect(() => {
    if (!busy) {
      setThink(null);
      // The active tab's turn ended: drop the transient region + refresh repo.
      setPending("");
      setLiveTool(null);
      refreshRepo();
      return;
    }
    const start = Date.now();
    setThink({ word: pickWord(Math.random()) });
    setElapsed(0);
    setSpin(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
      setSpin((s) => (s + 1) % frames.length);
    }, 120);
    return () => clearInterval(timer);
  }, [busy, frames.length]);

  // --- transcript emission -------------------------------------------------

  // Wipe the visible screen AND scrollback, home the cursor, then remount <Static>
  // (new key) so it re-emits `items` from scratch. Ink's Static only ever appends
  // the tail past its last write index, so a plain items swap would render nothing;
  // the remount resets that index. Used to make a tab switch a clean full-screen
  // replace (so each tab reads as its own session) and to toggle the split view.
  const resetScreen = (items: Log[]) => {
    stdout?.write("\x1b[2J\x1b[3J\x1b[H");
    setScreenKey((k) => k + 1);
    setScreen(items);
  };

  // Clear the screen and render ONLY this tab's transcript, headed by a divider.
  const rebuildScreen = (tab: Tab) => {
    const buf = tabBuf(tab.id);
    buf.shown = buf.log.length;
    const header: Log = { id: nextId(), kind: "system", text: `${g.h.repeat(2)} ${tab.name} ${g.h.repeat(2)}` };
    resetScreen([header, ...buf.log]);
  };

  // Append one line to a tab's buffer. The active tab's lines also flush to the
  // on-screen transcript immediately; a background tab's lines stay buffered and
  // only badge the tab bar. In split view nothing flushes to <Static> — the grid
  // cells read the buffers directly, so we just re-render.
  const emitToTab = (tab: Tab, item: DistributiveOmit<Log, "id">) => {
    const entry = { id: nextId(), ...item } as Log;
    const buf = tabBuf(tab.id);
    buf.log.push(entry);
    if (altRef.current) {
      if (!isActive(tab)) controller.markOutput(tab);
      setTabTick((t) => t + 1);
      return;
    }
    if (isActive(tab)) {
      buf.shown = buf.log.length;
      setScreen((s) => [...s, entry]);
    } else {
      controller.markOutput(tab);
    }
  };
  const sysLog = (text: string) => emitToTab(controller.active(), { kind: "system", text });

  // Callbacks for a turn running in `tab`. They check liveness on every call (a
  // tab can be switched to/from mid-turn), so a background turn buffers + badges
  // and, once foregrounded, streams to the screen.
  const buildCb = (tab: Tab): Callbacks => ({
    onLine: (line) =>
      emitToTab(tab, line.kind === "rule" ? { kind: "rule", lang: line.lang } : { kind: "line", text: line.text }),
    onPending: (text) => {
      if (isActive(tab)) setPending(text);
    },
    onAssistant: () => {},
    onToolStart: (call, args) => {
      if (!isActive(tab)) return;
      const p = callParts(call.name, args);
      setLiveTool(`${p.tool}(${p.primary}${p.secondary})`); // transient "running" indicator
    },
    onToolResult: (call, result) => {
      if (isActive(tab)) setLiveTool(null);
      if (result.aborted) {
        emitToTab(tab, { kind: "system", text: `⎿ ${call.name} aborted` });
        return;
      }
      let args: any = {};
      try { args = call.args ? JSON.parse(call.args) : {}; } catch { /* keep {} */ }
      const { tool, primary, secondary } = callParts(call.name, args);
      const body = resultBody({ isError: result.isError, verbose: verboseRef.current, name: call.name, args, output: result.output });
      emitToTab(tab, { kind: "tool", tool, primary, secondary, ok: !result.isError, body });
    },
    onSystem: (text) => emitToTab(tab, { kind: "system", text }),
    requestPermission: (preview) =>
      new Promise<PermissionAnswer>((resolve) => {
        // Active tab: prompt inline. Background tab: park it (badge amber, keep
        // focus); it surfaces when the user switches over.
        if (isActive(tab)) {
          permResolveRef.current = resolve;
          permPreviewRef.current = preview;
          permOwnerRef.current = tab.id;
          setOverlay({ type: "permission", preview });
        } else {
          controller.setPendingPermission(tab, { preview, resolve });
        }
      }),
  });

  const stubCb = (): Callbacks => ({
    onLine: () => {},
    onPending: () => {},
    onAssistant: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onSystem: sysLog,
    requestPermission: async () => "no",
  });

  // The controller runs a tab's turn through here (engine.run + per-tab callbacks).
  executorRef.current = (tab, text) => tab.engine.run(text, buildCb(tab));
  onChangeRef.current = () => setTabTick((t) => t + 1);

  const resolvePerm = (ans: PermissionAnswer) => {
    const r = permResolveRef.current;
    permResolveRef.current = null;
    permPreviewRef.current = null;
    permOwnerRef.current = null;
    setOverlay({ type: "none" });
    r?.(ans);
  };

  // --- tab switching -------------------------------------------------------

  // Bring `id` to the foreground: re-park any unanswered prompt on the outgoing
  // tab, chdir to the target, and flush the target's un-shown backlog (headed by
  // a divider) into the transcript. If the target parked a permission while in the
  // background, surface it now.
  const switchToTab = (id: number) => {
    const cur = controller.active();
    if (!controller.byId(id)) return;
    if (id === cur.id && !altRef.current) return; // already here (and not in split view)

    if (overlayRef.current.type === "permission" && permResolveRef.current && permOwnerRef.current === cur.id) {
      controller.setPendingPermission(cur, { preview: permPreviewRef.current!, resolve: permResolveRef.current });
      permResolveRef.current = null;
      permPreviewRef.current = null;
      permOwnerRef.current = null;
    }
    if (overlayRef.current.type !== "none") setOverlay({ type: "none" });
    setPending("");
    setLiveTool(null);
    altRef.current = false; // any tab switch leaves the split view
    setAlt(false);

    controller.setActive(id); // clears the target badge + chdirs to its cwd
    const tab = controller.byId(id)!;
    setRoot(tab.engine.cwd);
    refreshRepo();

    // Clear the screen and render only the target tab's transcript — each tab
    // reads as its own session rather than a continuation of the previous one.
    rebuildScreen(tab);

    const pp = controller.takePendingPermission(tab);
    if (pp) {
      permResolveRef.current = pp.resolve;
      permPreviewRef.current = pp.preview;
      permOwnerRef.current = tab.id;
      setOverlay({ type: "permission", preview: pp.preview });
    }
  };

  // Toggle the /alltabs split view. Entering clears the transcript (the grid shows
  // each tab's live tail); exiting rebuilds the active tab's single-tab transcript.
  const toggleAllTabs = () => {
    if (altRef.current) {
      altRef.current = false;
      setAlt(false);
      rebuildScreen(controller.active());
      return;
    }
    altRef.current = true;
    setAlt(true);
    setPending("");
    setLiveTool(null);
    resetScreen([]);
  };
  const switchToIndex = (pos: number) => {
    const t = controller.tabs[pos - 1];
    if (t) switchToTab(t.id);
  };

  const newTab = (name: string | undefined, purpose: string) => {
    const tab = controller.create(name, purpose);
    tabBuf(tab.id);
    switchToTab(tab.id);
    sysLog(`new tab ${g.chevron} ${tab.name}${purpose ? ` — ${purpose}` : ""}`);
  };

  const closeActiveTab = () => {
    if (controller.tabs.length <= 1) {
      sysLog("can't close the last tab");
      return;
    }
    const closing = controller.active();
    const now = controller.close(closing.id); // aborts it + resolves any parked prompt
    buffers.current.delete(closing.id);
    setPending("");
    setLiveTool(null);
    setOverlay({ type: "none" });
    permResolveRef.current = null;
    permPreviewRef.current = null;
    permOwnerRef.current = null;
    altRef.current = false;
    setAlt(false);
    setRoot(now.engine.cwd);
    refreshRepo();
    rebuildScreen(now);
    sysLog(`closed ${closing.name}`);
  };

  const listTabs = () => {
    const rows = controller.tabs.map((t, i) => {
      const flags = [
        t.id === controller.activeId ? "active" : null,
        t.busy ? "busy" : null,
        t.badge !== "none" ? t.badge : null,
      ].filter(Boolean);
      return `  ${i + 1}. ${t.name}${flags.length ? ` [${flags.join(", ")}]` : ""}${t.purpose ? `  —  ${t.purpose}` : ""}`;
    });
    sysLog(["tabs:", ...rows].join("\n"));
  };

  // --- command handling ----------------------------------------------------

  // Move the active tab's working root. Every tool resolves paths against
  // process.cwd(), so a chdir is all that's needed — no tool changes.
  const switchRoot = (abs: string) => {
    try {
      process.chdir(abs);
    } catch (e) {
      sysLog(`vault: cannot switch to ${abs} — ${(e as Error).message}`);
      return;
    }
    engine.cwd = abs; // the active tab remembers its root across switches
    setRoot(abs);
    getRepoInfo(abs).then(setRepo).catch(() => {});
    sysLog(`vault ${g.chevron} ${abs}`);
  };

  const openVault = async () => {
    const cfg = await loadConfig();
    if (!cfg.obsidianVault) {
      sysLog("no obsidian vault configured — set one with /vault set <path>");
      return;
    }
    const abs = path.resolve(cfg.obsidianVault);
    if (!existsSync(abs)) {
      sysLog(`vault path does not exist: ${abs}`);
      return;
    }
    switchRoot(abs);
  };

  const setVault = async (arg: string) => {
    if (!arg) {
      sysLog("usage: /vault set <path>");
      return;
    }
    const abs = path.resolve(arg);
    if (!existsSync(abs)) {
      sysLog(`vault path does not exist: ${abs}`);
      return;
    }
    // saveConfig read-merges, so apiKey/model and any other keys are preserved.
    await saveConfig({ obsidianVault: abs });
    switchRoot(abs);
  };

  const doUndo = async () => {
    const reverted = await undoLast();
    if (reverted) {
      sysLog(`reverted ${reverted}`);
      refreshRepo();
    } else {
      sysLog("nothing to undo");
    }
  };

  const showCheckpoints = async () => {
    const cps = await listCheckpoints();
    if (!cps.length) {
      sysLog("no checkpoints");
      return;
    }
    const rows = cps.map((c) => `  ${c.iso}  ${c.tool}  ${c.rel}`);
    sysLog(["checkpoints (newest first):", ...rows].join("\n"));
  };

  // Switch the ACTIVE tab's model. Session-scoped by default; `save` also writes
  // it to config.model as the new default (the only path that touches config).
  const applyModel = async (id: string, save = false) => {
    engine.setModel(id);
    const m = modelsRef.current.find((x) => x.id === id);
    sysLog(`model ${g.chevron} ${id}${save ? "  (saved as default)" : ""}${m ? `  ${priceLabel(m)}` : ""}`);
    // Persist the session durably (awaited) so a hard exit can't lose the switch.
    await engine.persist();
    if (save) {
      setSavedModel(id); // clears the status-bar divergence marker
      await saveConfig({ model: id }); // saveConfig read-merges, preserving other keys
    }
  };

  // /model <arg>: an exact full id switches immediately; anything fuzzier opens
  // the picker filtered to the matches with the best one preselected, so the full
  // resolved id is shown and confirmed before switching (never a silent guess).
  // `save` carries the "make this the default" intent through the picker.
  const selectModelByArg = async (arg: string, save = false) => {
    const models = await fetchModels();
    modelsRef.current = models;
    const res = resolveModelQuery(models, arg);
    if (res.kind === "exact") return applyModel(res.id, save);
    if (res.kind === "none") return sysLog(`no model matches "${arg}"`);
    const matched = models.filter((m) => res.ids.includes(m.id));
    setOverlay({ type: "model", items: buildModelItems(matched), initial: res.ids[0], save });
  };

  // /mode <ask|plan|yolo> [--save]. Session-scoped by default; `--save` also writes
  // it to config.mode as the new default (the only path that touches config).
  const setModeCmd = async (arg: string) => {
    const toks = arg.split(/\s+/).filter(Boolean);
    const save = toks.includes("--save") || toks.includes("-s");
    const modeArg = toks.find((t) => t === "ask" || t === "plan" || t === "yolo");
    if (!modeArg) {
      sysLog(`usage: /mode <ask|plan|yolo> [--save]`);
      return;
    }
    engine.setMode(modeArg as Mode);
    setModeTick((t) => t + 1);
    sysLog(`mode ${g.chevron} ${modeArg}${save ? "  (saved as default)" : ""}`);
    await engine.persist();
    if (save) await saveConfig({ mode: modeArg as Mode });
  };

  // shift+tab cycles: normal → auto-accept edits → yolo → normal. Session-scoped —
  // it never writes config (use `/mode <m> --save` to change the default).
  const cycleMode = () => {
    const next = cycleApprovalMode(engine.mode, engine.autoApproveEdits);
    engine.setMode(next.mode);
    engine.autoApproveEdits = next.autoApproveEdits;
    setModeTick((t) => t + 1);
    void engine.persist();
  };

  const openModelPicker = async () => {
    const models = await fetchModels();
    modelsRef.current = models;
    setOverlay({ type: "model", items: buildModelItems(models) });
  };

  const openSessionPicker = async () => {
    const all = await listSessions();
    if (!all.length) {
      sysLog("no saved sessions");
      return;
    }
    const items: PickItem[] = all.map((s) => ({
      value: s.id,
      label: s.id,
      hint: `${s.messages.length} msgs · ${s.model}${s.cwd === engine.cwd ? " · here" : ""}`,
    }));
    setOverlay({ type: "session", items });
  };

  const openFilePicker = async (prefix: string) => {
    const r = await runGlob({ pattern: "**/*" });
    const items: PickItem[] = r.isError
      ? []
      : r.output
          .split("\n")
          .filter((l) => l && !l.startsWith("[") && !l.startsWith("No files"))
          .slice(0, 500)
          .map((l) => {
            const tab = l.indexOf("\t");
            const p = tab === -1 ? l : l.slice(0, tab);
            const size = tab === -1 ? undefined : l.slice(tab + 1);
            return { value: p, label: p, hint: size ? `${size}b` : undefined };
          });
    setOverlay({ type: "file", items, prefix });
  };

  const handleCommand = (value: string) => {
    const parts = value.slice(1).split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ");
    switch (cmd) {
      case "help":
        sysLog(HELP);
        break;
      case "tools":
        sysLog("tools: " + TOOL_NAMES.join(", "));
        break;
      case "new":
        newTab(parts[1], parts.slice(2).join(" "));
        break;
      case "tabs":
        listTabs();
        break;
      case "tab": {
        if (!arg) {
          sysLog("usage: /tab <number|name>");
          break;
        }
        const n = Number(arg);
        if (Number.isInteger(n) && n > 0) {
          const t = controller.tabs[n - 1];
          if (t) switchToTab(t.id);
          else sysLog(`no tab ${n}`);
        } else {
          const t = controller.byName(arg);
          if (t) switchToTab(t.id);
          else sysLog(`no tab named "${arg}"`);
        }
        break;
      }
      case "close":
        closeActiveTab();
        break;
      case "alltabs":
        toggleAllTabs();
        break;
      case "skills": {
        const sk = engine.skills;
        if (!sk.length) {
          sysLog("no skills loaded — add SKILL.md under ~/.dom/skills/<name>/ (or ./.dom/skills/<name>/)");
          break;
        }
        const rows = sk.map(
          (s) => `  ${s.name}${s.scope === "project" ? " [project]" : ""}  —  ${s.description}`,
        );
        sysLog([`skills (${sk.length} loaded):`, ...rows].join("\n"));
        break;
      }
      case "cost": {
        const cached = engine.cost.cachedPromptTokens ?? 0;
        const uncached = Math.max(0, engine.cost.promptTokens - cached);
        sysLog(
          `in: ${uncached} uncached + ${cached} cached · out: ${engine.cost.completionTokens} · $${engine.cost.usd.toFixed(4)}`,
        );
        break;
      }
      case "verbose": {
        const nv = !verboseRef.current;
        setVerbose(nv);
        verboseRef.current = nv;
        sysLog(`verbose ${nv ? "on — full tool output" : "off — summarized tool output"}`);
        break;
      }
      case "clear": {
        engine.clear();
        const buf = tabBuf(controller.active().id);
        buf.log = [];
        buf.shown = 0;
        altRef.current = false;
        setAlt(false);
        resetScreen([{ id: nextId(), kind: "system", text: "conversation cleared" }]);
        break;
      }
      case "compact":
        engine.forceCompact(stubCb());
        break;
      case "mode":
        void setModeCmd(arg);
        break;
      case "model": {
        // /model               → picker (session switch; ctrl+s saves as default)
        // /model <id>          → switch the session only
        // /model --save [<id>] → switch AND save as default (no id: save current)
        const save = parts[1] === "--save" || parts[1] === "-s";
        const modelArg = save ? parts.slice(2).join(" ") : arg;
        if (save && !modelArg) void applyModel(engine.modelId, true);
        else if (modelArg) void selectModelByArg(modelArg, save);
        else void openModelPicker();
        break;
      }
      case "resume":
        void openSessionPicker();
        break;
      case "vault":
        if (!arg) void openVault();
        else if (parts[1]?.toLowerCase() === "set") void setVault(parts.slice(2).join(" "));
        else sysLog("usage: /vault  or  /vault set <path>");
        break;
      case "undo":
        void doUndo();
        break;
      case "checkpoints":
        void showCheckpoints();
        break;
      case "exit":
      case "quit":
        exit();
        break;
      default:
        sysLog(`unknown command: /${cmd} (try /help)`);
    }
  };

  const handleSubmit = (value: string) => {
    const v = value;
    setInput("");
    if (!v.trim() || busyRef.current) return;
    if (v.startsWith("!")) {
      const command = v.slice(1).trim();
      if (!command) return;
      sysLog(`! ${command}`);
      const tab = controller.active();
      controller.runForeground(tab, () => tab.engine.runBashDirect(command, buildCb(tab)));
      return;
    }
    if (v.startsWith("/")) {
      handleCommand(v.trim());
      return;
    }
    const tab = controller.active();
    emitToTab(tab, { kind: "user", text: v });
    controller.submitUser(tab, v);
  };

  const handleChange = (v: string) => {
    setInput(v);
    if (v.endsWith("@") && !busyRef.current) void openFilePicker(v.slice(0, -1));
  };

  // --- global keys ---------------------------------------------------------

  useInput((inp, key) => {
    if (key.ctrl && inp === "c") {
      // Second press within the 2s window: leave immediately, wedged or not.
      if (ctrlCArmedRef.current) {
        hardExit();
        return;
      }
      // A permission prompt is open: decline it and abort the turn.
      if (overlayRef.current.type === "permission") {
        resolvePerm("no");
        engine.abort();
        armCtrlCExit();
        return;
      }
      // A turn (or a running tool) is in flight in the active tab: abort it.
      if (busyRef.current) {
        engine.abort();
        armCtrlCExit();
        return;
      }
      // A picker overlay is open: just close it (no exit arming).
      if (overlayRef.current.type !== "none") {
        setOverlay({ type: "none" });
        return;
      }
      // Text in the input: clear it and arm the exit window.
      if (inputRef.current) {
        setInput("");
        armCtrlCExit();
        return;
      }
      // Idle at an empty prompt: arm; the next press exits.
      armCtrlCExit();
      return;
    }
    // Ctrl+1..9 switches tabs — always available, even while a turn is running so
    // you can leave a busy tab. Terminals that don't emit distinct Ctrl+digit
    // codes can use /tab <n> instead.
    if (key.ctrl && /^[1-9]$/.test(inp)) {
      switchToIndex(Number(inp));
      return;
    }
    // shift+tab cycles the approval mode when the input bar is active.
    if (key.tab && key.shift && overlayRef.current.type === "none" && !busyRef.current) {
      cycleMode();
    }
  });

  // --- render --------------------------------------------------------------

  const renderLog = (item: Log): ReactNode => {
    switch (item.kind) {
      case "banner":
        return <Banner caps={caps} width={width} tools={TOOL_NAMES} ghAuth={ghAuth} />;
      case "user":
        return (
          <Box>
            <Text color={col(C.chevron)}>{g.chevron} </Text>
            <Text color={col(C.value)}>{item.text}</Text>
          </Box>
        );
      case "line":
        // Empty committed lines keep their height (blank space " ") so paragraph
        // breaks and code spacing survive in the transcript.
        return <Text color={col(C.value)}>{item.text.length ? item.text : " "}</Text>;
      case "rule":
        // Fenced-code boundary: a dim rule, with the language tag if present.
        return (
          <Text color={col(C.frame)}>
            {g.h.repeat(3)}
            {item.lang ? " " + item.lang : ""}
          </Text>
        );
      case "tool": {
        const call = callLine({ tool: item.tool, primary: item.primary, secondary: item.secondary }, inner);
        const body = resultLines(item.body).join("\n");
        return (
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text color={col(item.ok ? C.ok : C.danger)}>{call.slice(0, 1)}</Text>
              <Text color={col(C.value)}>{call.slice(1)}</Text>
            </Text>
            {body ? <Text color={col(item.ok ? C.dim : C.danger)}>{body}</Text> : null}
          </Box>
        );
      }
      case "system":
        return <Text color={col(C.dim)}>{item.text}</Text>;
    }
  };

  const renderOverlay = (): ReactNode => {
    if (overlay.type === "permission") {
      return <Permission caps={caps} width={inner} preview={overlay.preview} onDecide={resolvePerm} />;
    }
    if (overlay.type === "model") {
      const save = overlay.save ?? false;
      return (
        <Picker
          caps={caps}
          width={inner}
          title={save ? "select model (will save as default)" : "select model"}
          items={overlay.items}
          initialValue={overlay.initial ?? engine.modelId}
          onSelect={(v) => {
            setOverlay({ type: "none" });
            void applyModel(v, save);
          }}
          onSave={(v) => {
            setOverlay({ type: "none" });
            void applyModel(v, true);
          }}
          saveHint="save as default"
          onCancel={() => setOverlay({ type: "none" })}
        />
      );
    }
    if (overlay.type === "file") {
      const prefix = overlay.prefix;
      return (
        <Picker
          caps={caps}
          width={inner}
          title="insert file path"
          items={overlay.items}
          onSelect={(v) => {
            setOverlay({ type: "none" });
            setInput(prefix + v + " ");
          }}
          onCancel={() => setOverlay({ type: "none" })}
        />
      );
    }
    if (overlay.type !== "session") return null;
    return (
      <Picker
        caps={caps}
        width={inner}
        title="resume session"
        items={overlay.items}
        onSelect={(id) => {
          setOverlay({ type: "none" });
          void loadSession(id).then((s) => {
            if (!s) {
              sysLog(`could not load session ${id}`);
              return;
            }
            engine.adoptSession(s);
            setScreen((prev) => [
              ...prev,
              { id: nextId(), kind: "system", text: `resumed ${id} (${s.messages.length} messages)` },
            ]);
            refreshRepo();
          });
        }}
        onCancel={() => setOverlay({ type: "none" })}
      />
    );
  };

  const tabInfos = controller.tabs.map((t) => ({
    name: t.name,
    active: t.id === controller.activeId,
    badge: t.badge,
    busy: t.busy,
  }));

  // Plain-text preview of a tab's transcript for a split-view cell: drop blanks
  // and flatten each entry to its display text (tool calls → the call line + the
  // first result line). Only used while the split view is open.
  const previewLines = (logs: Log[]): string[] => {
    const out: string[] = [];
    const push = (s: string) => {
      for (const ln of s.split("\n")) out.push(ln);
    };
    for (const l of logs) {
      switch (l.kind) {
        case "banner":
          break;
        case "user":
          out.push(`${g.chevron} ${l.text}`);
          break;
        case "line":
          if (l.text) out.push(l.text);
          break;
        case "rule":
          out.push(g.h.repeat(3) + (l.lang ? " " + l.lang : ""));
          break;
        case "tool": {
          out.push(callLine({ tool: l.tool, primary: l.primary, secondary: l.secondary }, 200));
          const b = resultLines(l.body);
          if (b[0]) out.push(b[0].trimStart());
          break;
        }
        case "system":
          push(l.text);
          break;
      }
    }
    return out;
  };

  // Split-view layout (only computed while open). contentRows is trimmed to the
  // terminal height so a many-tab grid can't overrun the screen.
  const altColumns = gridColumns(controller.tabs.length);
  const gridRowCount = Math.max(1, Math.ceil(controller.tabs.length / altColumns));
  const contentRows = Math.max(3, Math.min(6, Math.floor(((stdout?.rows || 40) - 6) / gridRowCount) - 2));
  const altLayout = alt
    ? layoutAllTabs({
        cells: controller.tabs.map((t) => ({
          name: t.name,
          active: t.id === controller.activeId,
          badge: t.badge,
          busy: t.busy,
          lines: previewLines(tabBuf(t.id).log),
        })),
        width: inner,
        glyphs: g,
        contentRows,
        stacked: cols < 100,
      })
    : null;

  // Height (logical rows) of the dynamic region below <Static>, mirroring the JSX
  // below. Read by the resize handler to erase the stale frame. Exact for the
  // steady region (status bar + input); overlays / the split grid use an at-or-
  // under estimate so the erase never reaches up into scrollback.
  const tabbarShown = controller.tabs.length > 1 && !alt;
  const boxedInput = caps.isTTY && !caps.legacy;
  const overlayRows =
    overlay.type === "permission"
      ? 8
      : overlay.type === "model" || overlay.type === "file" || overlay.type === "session"
        ? Math.min(overlay.items.length, 12) + 4
        : 0;
  let regionRows = 0;
  if (alt && altLayout) regionRows += altLayout.rows; // the split grid replaces the transient region
  else {
    if (pending) regionRows += 1;
    if (liveTool) regionRows += 1;
  }
  if (tabbarShown) regionRows += 2; // marginTop + tab bar
  regionRows += (tabbarShown ? 0 : 1) + 1; // status bar (+ its marginTop)
  if (ctrlCArmed) regionRows += 1;
  if (overlay.type !== "none") regionRows += 1 + overlayRows; // marginTop + overlay
  else if (busy) regionRows += 1; // thinking spinner
  else regionRows += boxedInput ? 4 : 2; // input box (3 border rows + 1 hint) or bare (2)
  regionRowsRef.current = regionRows;

  return (
    <Box flexDirection="column">
      <Static key={screenKey} items={screen}>{(item) => <Box key={item.id}>{renderLog(item)}</Box>}</Static>

      {/* Split view: a read-only tiled overview of every tab, live-updating in
          place. Replaces the single-tab transient region + tab bar. */}
      {alt && altLayout ? (
        <Box width={inner}>
          <AllTabs caps={caps} width={inner} layout={altLayout} />
        </Box>
      ) : null}

      {!alt && pending ? (
        <Box width={inner}>
          <Text color={col(C.value)} wrap="truncate-start">
            {pending}
          </Text>
        </Box>
      ) : null}
      {!alt && liveTool ? (
        <Box width={inner}>
          <Text color={col(C.dim)} wrap="truncate">
            {g.mid} {liveTool}
          </Text>
        </Box>
      ) : null}

      {/* Tab bar: one row above the status bar, bounded to cols-2. Only shown once
          a second tab exists — and not in the split view, where the grid already
          shows every tab. */}
      {tabbarShown ? (
        <Box marginTop={1} width={inner}>
          <TabBar caps={caps} width={inner} tabs={tabInfos} />
        </Box>
      ) : null}

      <Box marginTop={tabbarShown ? 0 : 1}>
        <StatusBar
          caps={caps}
          width={inner}
          cwd={root}
          branch={repo.branch}
          dirtyCount={repo.dirtyCount}
          modelName={engine.currentModel()?.name ?? engine.modelId}
          divergent={engine.modelId !== savedModel}
          contextWindow={engine.contextLength()}
          tokens={engine.contextTokens()}
          cost={engine.cost.usd}
        />
      </Box>

      {ctrlCArmed ? (
        <Box width={inner}>
          <Text color={col(C.dim)} wrap="truncate">
            press ctrl+c again to exit
          </Text>
        </Box>
      ) : null}

      {overlay.type !== "none" ? (
        <Box marginTop={1}>{renderOverlay()}</Box>
      ) : busy ? (
        <Box width={inner}>
          <Text color={col(C.cyan)} wrap="truncate">
            {frames[spin % frames.length]}{" "}
          </Text>
          <Text color={col(C.value)} wrap="truncate">
            {think?.word ?? "Thinking"}
          </Text>
          <Text color={col(C.dim)} wrap="truncate">
            {" "}
            for {formatElapsed(elapsed)} · ctrl+c to interrupt
          </Text>
        </Box>
      ) : (
        <InputBar
          caps={caps}
          width={inner}
          value={input}
          onChange={handleChange}
          onSubmit={handleSubmit}
          mode={engine.mode}
          autoApproveEdits={engine.autoApproveEdits}
        />
      )}
    </Box>
  );
}
