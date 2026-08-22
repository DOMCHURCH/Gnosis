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
import { callParts, callLine, resultLines, resultBody, toolDetail } from "./toolrender.js";
import { AllTabs } from "./AllTabsView.js";
import { layoutAllTabs, gridColumns } from "./alltabs.js";
import type { Caps } from "./terminal.js";
import { Engine, type Callbacks } from "../engine.js";
import type { Msg } from "../messages.js";
import { contextBreakdown } from "../messages.js";
import { TabsController, type Tab } from "../tabs.js";
import type { Preview, PermissionAnswer } from "../permissions.js";
import { TOOL_NAMES } from "../tools/index.js";
import { runGlob } from "../tools/glob.js";
import { loadImage, isImagePath } from "../tools/viewimage.js";
import { gatherPromptHistory } from "../history.js";
import { fetchModels, resolveModelQuery, type ModelEntry } from "../models.js";
import { getRepoInfo } from "../gitinfo.js";
import { undoLast, listCheckpoints } from "../checkpoint.js";
import { undoLastDomCommit } from "../autocommit.js";
import { jobs, type Job } from "../jobs.js";
import { listHooks } from "../hooks.js";
import { writeAgentsMd } from "../init.js";
import { buildRepoMap } from "../repomap.js";
import { listSessions, loadConfig, loadSession, saveConfig, type Mode } from "../config.js";
import { readTrace, summarizeTrace, formatTraceSummary } from "../trace.js";
import { notify } from "../notify.js";
import { createWorktree, listWorktrees, mergeWorktree, removeWorktree, slug as worktreeSlug } from "../worktree.js";
import { readMemory, appendMemory, clearMemory, countEntries, memoryPath } from "../memory.js";
import { addSchedule, removeSchedule, loadSchedules, nextRunAt } from "../schedule.js";
import { EventBus, createBridge, type AppBridge } from "../events.js";
import { startServer, type ServerHandle } from "../server.js";
import { helpText } from "../commands.js";
import { rankedFiles } from "../filesearch.js";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

type Log =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "line"; text: string }
  | { id: number; kind: "rule"; lang: string }
  | { id: number; kind: "tool"; tool: string; primary: string; secondary: string; ok: boolean; body: string; summary?: string; detail?: string }
  | { id: number; kind: "system"; text: string };

type Overlay =
  | { type: "none" }
  | { type: "permission"; preview: Preview }
  | { type: "model"; items: PickItem[]; initial?: string; save?: boolean }
  | { type: "file"; items: PickItem[]; prefix: string }
  | { type: "session"; items: PickItem[] }
  | { type: "history"; items: PickItem[] };

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
  /** Present only under `dom serve`: the web view's event bus + remote handlers.
   * When set, the controller emits to the bus and this component registers the
   * client→server handlers so a browser drives the SAME engines. A plain TUI run
   * has none until `/serve` creates one on demand. */
  bridge?: AppBridge;
  /** The server started by `dom serve` (so `/serve` can show/reprint/stop it). A
   * plain `dom` run has none until `/serve` starts one. */
  serveHandle?: ServerHandle;
}

const HELP = helpText();

// Image @references in a submitted message: `@path` tokens that name an existing
// image file. These get loaded and attached to the message for a vision model.
function imageRefsIn(text: string, cwd: string): string[] {
  const out: string[] = [];
  const re = /@(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m[1]!;
    if (isImagePath(p) && existsSync(path.resolve(cwd, p))) out.push(p);
  }
  return out;
}

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

export function App({ engine: rootEngine, caps, width, ghAuth, initialRepo, skillWarnings, defaultModel, bridge: initialBridge, serveHandle }: Props) {
  const { exit } = useApp();
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  // The web-view bridge. Set from the start under `dom serve`; otherwise created on
  // demand by `/serve` (which attaches the bus to the already-running engines).
  const [bridge, setBridge] = useState<AppBridge | undefined>(initialBridge);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  // The running web server (persistent line above the status bar). Seeded from the
  // handle `dom serve` started, else null until `/serve` starts one.
  const [serve, setServe] = useState<{ url: string; handle: ServerHandle } | null>(
    serveHandle ? { url: serveHandle.url, handle: serveHandle } : null,
  );
  const serveRef = useRef(serve);
  serveRef.current = serve;

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
  // Per-tab transcript buffers: the tab's lines, how many are already on screen,
  // and one-step blank-line deferral state (see emitToTab).
  type Buf = { log: Log[]; shown: number; pendingBlank: boolean; lastKind: string };
  const buffers = useRef<Map<number, Buf>>(new Map());
  const tabBuf = (id: number): Buf => {
    let b = buffers.current.get(id);
    if (!b) {
      b = { log: [], shown: 0, pendingBlank: false, lastKind: "" };
      buffers.current.set(id, b);
    }
    return b;
  };
  // Bumped to remount <Static> so it re-emits from scratch (a full-screen switch /
  // split-view toggle clears the terminal, then rebuilds the transcript).
  const [screenKey, setScreenKey] = useState(0);
  const { stdout } = useStdout();

  const [input, setInput] = useState("");
  // Type-ahead: lines submitted while a turn is running are queued (not dropped)
  // and shown dimly below the input, then sent as the next user message at the
  // turn boundary. Stored per tab so switching tabs preserves each tab's queue;
  // `queued` mirrors the ACTIVE tab's queue for rendering.
  const queuesRef = useRef<Map<number, string[]>>(new Map());
  const [queued, setQueued] = useState<string[]>([]);
  // Set when a ctrl+c abort ends the turn: the queue is KEPT (not auto-fired) at
  // that boundary. Normal completion auto-fires the queue; an abort preserves it
  // for the user to send (empty enter), edit, or drop (esc).
  const flushSuppressedRef = useRef(false);
  // Desktop notifications (config `notify`, default on). Loaded once on mount.
  const notifyRef = useRef(true);
  // Whether the busy→idle transition was a ctrl+c abort (skip the finish notify).
  const abortedTurnRef = useRef(false);
  // Tracks the previous busy value so the effect can detect a real turn boundary.
  const wasBusyRef = useRef(false);
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
  // The working root of the active tab (its engine.cwd), shown in the status bar;
  // /vault and tab switches move it. Not tied to the global process cwd.
  const [root, setRoot] = useState(rootEngine.cwd);
  // Bumped by the tabs controller (onChange) so busy/badge/tab-bar state repaints.
  const [, setTabTick] = useState(0);
  // /alltabs split view: a read-only tiled overview of every tab replaces the
  // single-tab transcript. Input still routes to the active tab; any /tab switch
  // (or /alltabs again) exits back to single view.
  const [alt, setAlt] = useState(false);
  const altRef = useRef(false);
  altRef.current = alt;
  // Latest handler for a background job finishing — kept in a ref so the once-only
  // subscription (below) always calls the current closure (emitToTab/controller).
  const jobDoneRef = useRef<(j: Job) => void>(() => {});

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
  // The live selection overlay (model/session/file/history). Like permissions,
  // either the TUI Picker or a web client resolves it — first wins. `settle` does
  // the one-time bookkeeping (returns false if already resolved); `pick` runs the
  // select action. A web answer of null is a cancel.
  const overlaySeqRef = useRef(0);
  const activePickRef = useRef<{ id: string; settle: () => boolean; pick: (v: string) => void } | null>(null);
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
      bridge?.bus,
      bridge,
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

  // Subscribe once to background-job completions; the handler ref stays current.
  useEffect(() => {
    const h = (j: Job) => jobDoneRef.current(j);
    jobs.on("done", h);
    return () => {
      jobs.off("done", h);
    };
  }, []);

  // Load the notify preference once (default on).
  useEffect(() => {
    loadConfig().then((c) => { notifyRef.current = c.notify ?? true; }).catch(() => {});
  }, []);

  // Repo info follows the ACTIVE tab's working root (each engine owns its cwd),
  // not the global process cwd. Callers that just switched pass the new cwd.
  const refreshRepo = (cwd: string = controller.active().engine.cwd) => {
    getRepoInfo(cwd).then(setRepo).catch(() => {});
  };

  useEffect(() => {
    if (!busy) {
      // A real turn just ended (busy true→false): notify unless it was a ctrl+c abort.
      if (wasBusyRef.current) {
        if (!abortedTurnRef.current) notify("dom", "turn finished", { enabled: notifyRef.current });
        abortedTurnRef.current = false;
        wasBusyRef.current = false;
      }
      setThink(null);
      // The active tab's turn ended: drop the transient region + refresh repo.
      setPending("");
      setLiveTool(null);
      refreshRepo();
      return;
    }
    wasBusyRef.current = true;
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
    buf.pendingBlank = false;
    const header: Log = { id: nextId(), kind: "system", text: `${g.h.repeat(2)} ${tab.name} ${g.h.repeat(2)}` };
    resetScreen([header, ...buf.log]);
  };

  // Flush a finished entry to the tab's buffer and, for the active tab in single
  // view, to the on-screen transcript. In split view nothing flushes to <Static>;
  // the grid cells read the buffers directly, so we just re-render.
  const commit = (tab: Tab, entry: Log) => {
    const buf = tabBuf(tab.id);
    buf.log.push(entry);
    buf.lastKind = entry.kind;
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

  // A background tab's lines stay buffered (badge only); the active tab's surface
  // immediately. Blank lines are deferred one step: a paragraph break that would
  // hug a tool block (the model's "\n\n" before its one-line finding, then the
  // call) is dropped instead of wasting a row, and runs of blanks collapse to one.
  // A blank only survives between two ordinary prose lines.
  // Mirror a committed transcript item to the event bus so the browser renders
  // byte-identical content (this is the "same transcript" guarantee). A tool item
  // becomes a tool.end event; everything else is a line event carrying the item.
  const mirror = (tabId: number, item: DistributiveOmit<Log, "id">) => {
    const bus = bridge?.bus;
    if (!bus) return;
    try {
      if (item.kind === "tool") {
        // summary is the compact one-liner; detail is the full result (both computed
        // in onToolResult so the web is independent of the TUI's /verbose toggle).
        bus.emit({ type: "tool.end", tabId, tool: item.tool, primary: item.primary, secondary: item.secondary, ok: item.ok, summary: item.summary ?? item.body, detail: item.detail ?? item.body });
      } else if (item.kind !== "banner") {
        bus.emit({ type: "line", tabId, item });
      }
    } catch {
      /* emit and forget */
    }
  };

  const emitToTab = (tab: Tab, item: DistributiveOmit<Log, "id">) => {
    const buf = tabBuf(tab.id);
    if (item.kind === "line" && item.text === "") {
      buf.pendingBlank = true;
      return;
    }
    if (buf.pendingBlank) {
      buf.pendingBlank = false;
      if (item.kind !== "tool" && buf.lastKind !== "tool") commit(tab, { id: nextId(), kind: "line", text: "" });
    }
    commit(tab, { id: nextId(), ...item } as Log);
    mirror(tab.id, item);
  };
  const sysLog = (text: string) => emitToTab(controller.active(), { kind: "system", text });

  // --- queued input (type-ahead while a turn runs) -------------------------

  const activeQueue = (): string[] => queuesRef.current.get(controller.active().id) ?? [];
  const syncQueued = () => setQueued([...activeQueue()]);
  const enqueueInput = (text: string) => {
    const id = controller.active().id;
    const arr = queuesRef.current.get(id) ?? [];
    arr.push(text);
    queuesRef.current.set(id, arr);
    syncQueued();
  };
  const clearQueue = () => {
    queuesRef.current.delete(controller.active().id);
    syncQueued();
  };
  // Send the active tab's queued lines as a single next user message.
  const flushQueue = () => {
    const tab = controller.active();
    const arr = queuesRef.current.get(tab.id);
    if (!arr || !arr.length) return;
    queuesRef.current.delete(tab.id);
    syncQueued();
    const text = arr.join("\n");
    emitToTab(tab, { kind: "user", text });
    controller.submitUser(tab, text);
  };

  // At a turn boundary (the active tab goes idle) auto-send any queued input —
  // unless a ctrl+c abort ended the turn, in which case the queue is kept for the
  // user. Fires on every busy→false transition; a no-op when the queue is empty.
  useEffect(() => {
    if (busy) return;
    if (flushSuppressedRef.current) {
      flushSuppressedRef.current = false;
      return;
    }
    flushQueue();
    // flushQueue reads live refs; re-running only on the busy edge is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // A background job finished/was killed: append a dim line to the tab that
  // launched it (or the active tab if that tab is gone).
  jobDoneRef.current = (job: Job) => {
    const tab = (job.owner ? controller.byName(job.owner) : null) ?? controller.active();
    const label = job.status === "killed" ? "killed" : job.status === "error" ? `exited ${job.exitCode}` : "finished";
    emitToTab(tab, { kind: "system", text: `⎿ background job ${job.id} ${label}: ${job.command}` });
  };

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
      // The web chat wants the compact summary (always) + the full detail (for
      // click-to-expand), independent of the TUI's /verbose setting.
      const summary = resultBody({ isError: result.isError, verbose: false, name: call.name, args, output: result.output });
      const detail = toolDetail(call.name, args, result.output);
      emitToTab(tab, { kind: "tool", tool, primary, secondary, ok: !result.isError, body, summary, detail });
    },
    onSystem: (text) => emitToTab(tab, { kind: "system", text }),
    onTurnCost: (c) => {
      const uncached = Math.max(0, c.promptTokens - c.cachedTokens);
      const cached = c.cachedTokens > 0 ? ` (${c.cachedTokens} cached)` : "";
      emitToTab(tab, { kind: "system", text: `${g.mid} turn: ${uncached}${cached} in · ${c.completionTokens} out · $${c.usd.toFixed(4)}` });
    },
    requestPermission: (preview) =>
      new Promise<PermissionAnswer>((resolve) => {
        const label = preview.kind === "diff" ? preview.path : preview.kind === "bash" ? preview.command : `${preview.method} ${preview.url}`;
        notify("dom", `needs approval: ${label}`, { enabled: notifyRef.current });
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
    syncQueued(); // show the target tab's own type-ahead queue

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

  const newTab = (name: string | undefined, purpose: string, cwd?: string) => {
    const tab = controller.create(name, purpose, cwd);
    tabBuf(tab.id);
    switchToTab(tab.id);
    sysLog(`new tab ${g.chevron} ${tab.name}${purpose ? ` — ${purpose}` : ""}`);
  };

  // /worktree — isolate work in a separate git worktree + tab (branch dom/<name>).
  const handleWorktree = async (wargs: string[]) => {
    const sub = (wargs[0] ?? "").toLowerCase();
    const cwd = controller.active().engine.cwd;
    if (!sub || sub === "list") {
      const list = await listWorktrees(cwd);
      if (!list.length) {
        sysLog("no dom worktrees. `/worktree <name>` opens one in an isolated branch + tab.");
        return;
      }
      sysLog(["worktrees:", ...list.map((w) => `  ${w.name}  ${g.chevron} ${w.branch}  ${w.path}`)].join("\n"));
      return;
    }
    if (sub === "merge") {
      const name = wargs[1];
      if (!name) { sysLog("usage: /worktree merge <name>"); return; }
      sysLog(`⟳ merging worktree ${worktreeSlug(name)}…`);
      const r = await mergeWorktree(cwd, name);
      sysLog(r.ok ? `✓ merged dom/${worktreeSlug(name)} into the current branch` : `✗ merge failed: ${r.error}`);
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const name = wargs[1];
      if (!name) { sysLog("usage: /worktree remove <name> [--force]"); return; }
      const force = wargs.includes("--force") || wargs.includes("-f");
      const r = await removeWorktree(cwd, name, { force, deleteBranch: true });
      sysLog(r.ok ? `✓ removed worktree ${worktreeSlug(name)} (branch deleted)` : `✗ ${r.error}`);
      return;
    }
    // Anything else is a name to create a worktree for (and open a tab rooted there).
    const name = wargs.join(" ");
    sysLog(`⟳ creating worktree ${worktreeSlug(name)}…`);
    const r = await createWorktree(cwd, name);
    if (!r.ok) { sysLog(`✗ ${r.error}`); return; }
    newTab(r.info.name, `worktree ${r.info.branch}`, r.info.path);
    sysLog(
      `✓ worktree ${r.info.name} on ${r.info.branch} — isolated at ${r.info.path}.\n` +
        `  Edits here don't touch your working tree. \`/worktree merge ${r.info.name}\` brings it back; \`/worktree remove ${r.info.name}\` discards it.`,
    );
  };

  const closeActiveTab = () => {
    if (controller.tabs.length <= 1) {
      sysLog("can't close the last tab");
      return;
    }
    const closing = controller.active();
    const now = controller.close(closing.id); // aborts it + resolves any parked prompt
    buffers.current.delete(closing.id);
    queuesRef.current.delete(closing.id);
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
    syncQueued();
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

  // Move the active tab's working root. Each engine owns its cwd and every tool
  // resolves against it via ctx — so we update THIS tab's engine.cwd, never the
  // global process cwd (which would corrupt other tabs' path resolution).
  const switchRoot = (abs: string) => {
    engine.cwd = abs; // the active tab remembers its root across switches
    setRoot(abs);
    refreshRepo(abs);
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
    // Prefer reverting the last dom auto-commit; fall back to the checkpoint ref
    // (used when auto-commit is off or the change was never committed).
    const undoneCommit = await undoLastDomCommit(engine.cwd);
    if (undoneCommit) {
      sysLog(`reverted last dom commit — ${undoneCommit.message}`);
      refreshRepo();
      return;
    }
    const reverted = await undoLast(engine.cwd);
    if (reverted) {
      sysLog(`reverted ${reverted}`);
      refreshRepo();
    } else {
      sysLog("nothing to undo");
    }
  };

  const runMap = async () => {
    const cfg = await loadConfig();
    const budget = cfg.mapTokens ?? 1024;
    const m = await buildRepoMap(engine.cwd, budget);
    if (!m.text) {
      sysLog("repo map is empty (no supported source files, or no grammar installed)");
      return;
    }
    sysLog(`${m.text}\n\n(${m.tokens} tokens · budget ${budget} · ${m.files} files, ${m.parsed} parsed / ${m.cached} cached)`);
  };

  const runInit = async (force: boolean) => {
    const r = await writeAgentsMd(engine.cwd, force);
    if (!r.written) {
      sysLog(r.reason ?? "could not write AGENTS.md");
      return;
    }
    sysLog(`wrote ${path.relative(engine.cwd, r.path).split(path.sep).join("/") || "AGENTS.md"} (${r.lineCount} lines) — it's appended to the system prompt next session`);
    refreshRepo();
  };

  const showHooks = async () => {
    const hs = await listHooks(engine.cwd);
    if (!hs.length) {
      sysLog("no hooks registered — add scripts under ~/.dom/hooks/ or ./.dom/hooks/ (SessionStart, PreToolUse, PostToolUse, Stop)");
      return;
    }
    const rows = hs.map((h) => `  ${h.event} [${h.scope}]  ${h.path}`);
    sysLog(["hooks:", ...rows].join("\n"));
  };

  const listJobs = () => {
    const all = jobs.list();
    if (!all.length) {
      sysLog("no background jobs");
      return;
    }
    const rows = all.map((j) => {
      const secs = Math.floor((Date.now() - j.startedAt) / 1000);
      const st = j.status === "running" ? `running ${secs}s` : j.status === "error" ? `exit ${j.exitCode}` : j.status;
      return `  ${j.id}. [${st}] ${j.command}`;
    });
    sysLog(["background jobs:", ...rows].join("\n"));
  };
  const showJob = (id: string) => {
    const out = jobs.output(id);
    if (out === null) {
      sysLog(`no job ${id}`);
      return;
    }
    const j = jobs.get(id);
    sysLog(`job ${id} (${j?.status ?? "?"}) — ${j?.command ?? ""}\n${out}`);
  };
  const killJob = (id: string) => {
    const j = jobs.get(id);
    if (!j) {
      sysLog(`no job ${id}`);
      return;
    }
    if (j.status !== "running") {
      sysLog(`job ${id} is already ${j.status}`);
      return;
    }
    jobs.kill(id);
    sysLog(`killed job ${id}: ${j.command}`);
  };

  const showCheckpoints = async () => {
    const cps = await listCheckpoints(engine.cwd);
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

  // Arm a selection overlay for cross-client resolution. The TUI Picker still
  // renders from `overlay` state (the caller sets that); this additionally emits
  // `overlay.open` so a browser can render the same list, and registers a resolver
  // so a web `overlay.select`/`overlay.cancel` runs the SAME `pick`. Whichever
  // client answers first wins (settle() is one-shot); the other side closes when
  // the resulting `overlay.resolved` is observed.
  const armOverlay = (kind: string, title: string, items: PickItem[], selected: string | null, pick: (v: string) => void): void => {
    const id = `overlay:${activeTab.id}:${++overlaySeqRef.current}`;
    let done = false;
    const settle = (): boolean => {
      if (done) return false;
      done = true;
      activePickRef.current = null;
      setOverlay({ type: "none" });
      if (bridge) {
        bridge.clearOverlay(id);
        bridge.bus.emit({ type: "overlay.resolved", id });
      }
      return true;
    };
    activePickRef.current = { id, settle, pick };
    if (bridge) {
      bridge.registerOverlay(id, (v) => {
        if (settle() && v !== null) pick(v); // a web client answered
      });
      bridge.bus.emit({
        type: "overlay.open",
        tabId: activeTab.id,
        id,
        kind,
        title,
        items: items.map((it) => ({ value: it.value, label: it.label })),
        selected,
      });
    }
  };

  // The TUI Picker resolved: run the shared select action (null = cancel).
  const resolveOverlay = (v: string | null): void => {
    const a = activePickRef.current;
    if (a && a.settle() && v !== null) a.pick(v);
  };
  // Ctrl+S in the model Picker: resolve, then save-as-default (TUI-only affordance).
  const saveOverlay = (v: string): void => {
    const a = activePickRef.current;
    if (a && a.settle()) void applyModel(v, true);
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
    const items = buildModelItems(matched);
    setOverlay({ type: "model", items, initial: res.ids[0], save });
    armOverlay("model", save ? "select model (will save as default)" : "select model", items, res.ids[0] ?? null, (v) => void applyModel(v, save));
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

  // /approve (plan mode): switch to ask and execute the written plan. The plan is
  // the model's last assistant message; it's fed back so execution is grounded in it.
  const approvePlan = () => {
    if (engine.mode !== "plan") {
      sysLog("/approve only applies in plan mode");
      return;
    }
    const plan = [...engine.messages]
      .reverse()
      .find((m): m is Extract<Msg, { role: "assistant" }> => m.role === "assistant" && !!m.text)?.text;
    engine.setMode("ask");
    setModeTick((t) => t + 1);
    void engine.persist();
    sysLog("plan approved — switching to ask mode and executing");
    const text = plan ? `The plan is approved. Implement it now:\n\n${plan}` : "The plan is approved. Implement it now.";
    controller.submitUser(controller.active(), text);
  };

  // /revise <text> (plan mode): amend the plan without executing (stays read-only).
  const revisePlan = (text: string) => {
    if (engine.mode !== "plan") {
      sysLog("/revise only applies in plan mode");
      return;
    }
    if (!text.trim()) {
      sysLog("usage: /revise <what to change>");
      return;
    }
    sysLog(`revising the plan: ${text}`);
    controller.submitUser(controller.active(), `Please revise the plan: ${text}`);
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
    const items = buildModelItems(models);
    setOverlay({ type: "model", items });
    armOverlay("model", "select model", items, engine.modelId, (v) => void applyModel(v, false));
  };

  const openSessionPicker = async () => {
    const all = await listSessions();
    // /resume with no args → prior sessions for THIS cwd (newest first).
    const here = all.filter((s) => s.cwd === engine.cwd && s.id !== engine.sessionId());
    if (!here.length) {
      sysLog(all.length ? "no prior sessions for this directory" : "no saved sessions");
      return;
    }
    const items: PickItem[] = here.map((s) => {
      const ago = Math.max(0, Math.round((Date.now() - s.updatedAt) / 60000));
      const when = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
      return { value: s.id, label: s.id, hint: `${s.messages.length} msgs · ${s.model} · ${when}`, search: `${s.id} ${s.model}` };
    });
    setOverlay({ type: "session", items });
    armOverlay("session", "resume session", items, null, (id) => resumeSession(id));
  };

  // Adopt a prior session into the active engine (shared by the TUI picker and a
  // web `overlay.select`), logging the outcome to the transcript.
  const resumeSession = (id: string): void => {
    void loadSession(id).then((s) => {
      if (!s) {
        sysLog(`could not load session ${id}`);
        return;
      }
      engine.adoptSession(s);
      setScreen((prev) => [...prev, { id: nextId(), kind: "system", text: `resumed ${id} (${s.messages.length} messages)` }]);
      refreshRepo();
    });
  };

  // Ctrl+R reverse-search: prior user prompts from THIS session (newest first),
  // then prior sessions for the same cwd. Reuses the filterable Picker overlay.
  const openHistorySearch = async () => {
    const prompts = gatherPromptHistory({
      currentMessages: engine.messages,
      currentSessionId: engine.sessionId(),
      sessions: await listSessions(),
      cwd: engine.cwd,
    });
    if (!prompts.length) {
      sysLog("no prompt history for this directory yet");
      return;
    }
    const items: PickItem[] = prompts.map((p) => ({ value: p, label: p.replace(/\s+/g, " ").slice(0, 200), search: p }));
    setOverlay({ type: "history", items });
    armOverlay("history", "reverse-search prompt history", items, null, (v) => setInput(v));
  };

  // Repo-map file ranking for @-completion, memoized per cwd (the map is DB-cached
  // so the first build is cheap; later @ opens reuse this).
  const repoRankRef = useRef<{ cwd: string; rank: Map<string, number> } | null>(null);
  const repoRanking = async (cwd: string): Promise<Map<string, number>> => {
    if (repoRankRef.current?.cwd === cwd) return repoRankRef.current.rank;
    let rank = new Map<string, number>();
    try {
      const cfg = await loadConfig();
      const map = await buildRepoMap(cwd, cfg.mapTokens ?? 1024);
      rank = new Map(map.rankedFiles.map((p, i) => [p, i]));
    } catch {
      /* no grammar / parse error — fall back to unranked (alpha) */
    }
    repoRankRef.current = { cwd, rank };
    return rank;
  };

  const openFilePicker = async (prefix: string) => {
    const cwd = controller.active().engine.cwd;
    const r = await runGlob({ pattern: "**/*" }, undefined, { cwd });
    const rank = await repoRanking(cwd);
    const files = r.isError
      ? []
      : r.output
          .split("\n")
          .filter((l) => l && !l.startsWith("[") && !l.startsWith("No files"))
          .map((l) => {
            const tab = l.indexOf("\t");
            const p = tab === -1 ? l : l.slice(0, tab);
            const size = tab === -1 ? undefined : l.slice(tab + 1);
            return { value: p, label: p, search: p, rank: rank.get(p), hint: size ? `${size}b` : undefined };
          });
    // Base order: repo-map-central files first (rank asc), then the rest alpha.
    files.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.value.localeCompare(b.value));
    const items = files.slice(0, 1000);
    setOverlay({ type: "file", items, prefix });
    armOverlay("file", "insert file path (fuzzy, repo-map ranked)", items, null, (v) => setInput(prefix + v + " "));
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
      case "worktree":
      case "wt":
        void handleWorktree(parts.slice(1));
        break;
      case "memory":
      case "mem": {
        const eng = controller.active().engine;
        const sub = (parts[1] ?? "").toLowerCase();
        if (sub === "clear") {
          void clearMemory(eng.cwd).then(() => sysLog("memory: bank cleared for this project."));
        } else if (sub === "add") {
          const note = parts.slice(2).join(" ");
          if (!note) sysLog("usage: /memory add <note>");
          else void appendMemory(eng.cwd, note).then((n) => sysLog(`✓ memory: saved (${n} note${n === 1 ? "" : "s"}).`));
        } else {
          void readMemory(eng.cwd).then((c) =>
            sysLog(
              c
                ? `memory (${countEntries(c)} notes) — ${memoryPath(eng.cwd)}:\n${c}`
                : "memory: empty for this project. The model saves notes with the memory tool; /memory add <note> adds one; /memory clear erases.",
            ),
          );
        }
        break;
      }
      case "schedule":
      case "sched": {
        const eng = controller.active().engine;
        const sub = (parts[1] ?? "list").toLowerCase();
        if (sub === "add") {
          const rest = parts.slice(2).join(" ");
          const bar = rest.indexOf("|");
          const spec = (bar >= 0 ? rest.slice(0, bar) : "").trim();
          const prompt = (bar >= 0 ? rest.slice(bar + 1) : "").trim();
          if (!spec || !prompt) {
            sysLog("usage: /schedule add <spec> | <prompt>   e.g. /schedule add every 1h | check the build");
          } else {
            void addSchedule({ spec, prompt, cwd: eng.cwd }, Date.now(), Math.floor(Math.random() * 1e6).toString(36)).then((r) =>
              sysLog(
                r.ok
                  ? `✓ scheduled ${r.schedule.id}: ${r.schedule.spec} — next ${new Date(nextRunAt(r.schedule, Date.now()) ?? Date.now()).toLocaleString()}. Fires via \`dom schedule tick\`.`
                  : `✗ ${r.error}`,
              ),
            );
          }
        } else if (sub === "remove" || sub === "rm") {
          const id = parts[2];
          if (!id) sysLog("usage: /schedule remove <id>");
          else void removeSchedule(id).then((ok) => sysLog(ok ? `✓ removed ${id}` : `no schedule ${id}`));
        } else {
          void loadSchedules().then((all) => {
            if (!all.length) {
              sysLog("no scheduled runs. /schedule add <spec> | <prompt>. A cron entry / `dom schedule tick` fires due ones.");
              return;
            }
            const now = Date.now();
            const rows = all.map(
              (s) =>
                `  ${s.id} [${s.enabled ? "on" : "off"}] ${s.spec} — ${s.prompt}\n     next ${new Date(nextRunAt(s, now) ?? now).toLocaleString()}${s.lastStatus ? `  · last ${s.lastStatus}` : ""}`,
            );
            sysLog([`scheduled runs (${all.length}):`, ...rows].join("\n"));
          });
        }
        break;
      }
      case "workspace":
      case "ws": {
        const eng = controller.active().engine;
        const sub = (parts[1] ?? "").toLowerCase();
        if (!sub || sub === "list") {
          const rows = eng.roots.map((r, i) => `  ${i === 0 ? g.chevron : " "} ${r}${i === 0 ? "  (primary)" : ""}`);
          sysLog([`workspace roots (${eng.roots.length}) — grep/glob without a path search all:`, ...rows].join("\n"));
        } else if (sub === "add") {
          const p = parts.slice(2).join(" ");
          if (!p) sysLog("usage: /workspace add <path>");
          else {
            const r = eng.addRoot(p);
            sysLog(r.ok ? `✓ added workspace root: ${r.message}` : `✗ ${r.message}`);
          }
        } else if (sub === "remove" || sub === "rm") {
          const p = parts.slice(2).join(" ");
          if (!p) sysLog("usage: /workspace remove <path>");
          else {
            const r = eng.removeRoot(p);
            sysLog(r.ok ? `✓ removed workspace root: ${r.message}` : `✗ ${r.message}`);
          }
        } else {
          sysLog("usage: /workspace [list | add <path> | remove <path>]");
        }
        break;
      }
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
      case "budget": {
        if (arg) {
          const n = Number(arg);
          if (n > 0) { engine.budgetUsd = n; engine.budgetCeiling = n; sysLog(`budget ceiling set to $${n.toFixed(2)}`); }
          else sysLog("usage: /budget <usd>");
        } else {
          const ceil = engine.budgetCeiling === Infinity ? "∞" : `$${engine.budgetCeiling.toFixed(2)}`;
          sysLog(`budget: $${engine.cost.usd.toFixed(4)} spent / ${ceil} ceiling`);
        }
        break;
      }
      case "verify": {
        sysLog("⟳ verifying the last change…");
        void engine.runVerifier().then((v) => {
          if (!v) sysLog("nothing to verify (no file edits in the last turn, or no diff)");
          else sysLog(v.verdict === "pass" ? `✓ verifier: ${v.text}` : `✗ verifier (${v.verdict}): ${v.text}`);
        }).catch((e) => sysLog(`verify: ${(e as Error).message}`));
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
        const head = win
          ? `context: ${total} tokens used / ${win} window (${Math.round((total / win) * 100)}% full)`
          : `context: ${total} tokens used`;
        sysLog([head, ...rows].join("\n"));
        break;
      }
      case "trace": {
        const sid = engine.sessionId();
        void readTrace(sid).then((events) => {
          if (!events.length) {
            sysLog("no trace yet for this session (traces are written per model/tool call to ~/.dom/traces)");
            return;
          }
          sysLog(formatTraceSummary(sid, summarizeTrace(events)));
        });
        break;
      }
      case "cost": {
        const cached = engine.cost.cachedPromptTokens ?? 0;
        const uncached = Math.max(0, engine.cost.promptTokens - cached);
        const sub = engine.cost.subAgentUsd ?? 0;
        const oracle = engine.cost.oracleUsd ?? 0;
        const extras: string[] = [];
        if (sub > 0) extras.push(`$${sub.toFixed(4)} sub-agents`);
        if (oracle > 0) extras.push(`$${oracle.toFixed(4)} oracle`);
        sysLog(
          `in: ${uncached} uncached + ${cached} cached · out: ${engine.cost.completionTokens} · $${engine.cost.usd.toFixed(4)}` +
            (extras.length ? ` (incl. ${extras.join(", ")})` : ""),
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
        buf.pendingBlank = false;
        buf.lastKind = "";
        altRef.current = false;
        setAlt(false);
        clearQueue();
        resetScreen([{ id: nextId(), kind: "system", text: "conversation cleared" }]);
        break;
      }
      case "compact":
        engine.forceCompact(stubCb());
        break;
      case "mode":
        void setModeCmd(arg);
        break;
      case "approve":
        approvePlan();
        break;
      case "revise":
        revisePlan(arg);
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
      case "init":
        void runInit(parts[1] === "--force" || parts[1] === "-f");
        break;
      case "map":
        void runMap();
        break;
      case "hooks":
        void showHooks();
        break;
      case "serve":
        void handleServe(arg);
        break;
      case "jobs":
        listJobs();
        break;
      case "job":
        if (!arg) sysLog("usage: /job <id>");
        else showJob(arg);
        break;
      case "kill":
        if (!arg) sysLog("usage: /kill <id>");
        else killJob(arg);
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
    if (busyRef.current) {
      // A turn is running: queue non-empty text as the next message. Commands and
      // shell are for the idle prompt; while busy everything is a queued message.
      if (v.trim()) enqueueInput(v);
      return;
    }
    // Idle: an empty submit flushes a queue the user is holding (e.g. one kept
    // after a ctrl+c abort); otherwise there's nothing to send.
    if (!v.trim()) {
      if (activeQueue().length) flushQueue();
      return;
    }
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
    // @image references: on a vision model, load them and attach to this message.
    const imagePaths = imageRefsIn(v, tab.engine.cwd);
    if (imagePaths.length && tab.engine.supportsImageInput()) {
      emitToTab(tab, { kind: "user", text: v });
      void (async () => {
        const imgs = [];
        for (const p of imagePaths) {
          const r = await loadImage(path.resolve(tab.engine.cwd, p), tab.engine.cwd);
          if ("error" in r) sysLog(r.error);
          else imgs.push({ source: r.source, mime: r.mime, data: r.data });
        }
        if (imgs.length) {
          tab.engine.setNextUserImages(imgs);
          sysLog(`${g.mid} attached ${imgs.length} image${imgs.length === 1 ? "" : "s"}`);
        }
        controller.submitUser(tab, v);
      })();
      return;
    }
    if (imagePaths.length) {
      sysLog(`current model (${tab.engine.modelId}) can't view images — switch to a vision model with /model. Sending as text.`);
    }
    emitToTab(tab, { kind: "user", text: v });
    controller.submitUser(tab, v);
  };

  const handleChange = (v: string) => {
    setInput(v);
    if (v.endsWith("@") && !busyRef.current) void openFilePicker(v.slice(0, -1));
  };

  // --- web view bridge (dom serve / /serve) --------------------------------

  // Wire a bridge's client→server handlers so a browser drives the SAME engines
  // (never OpenRouter, never a second loop). Called every render for the current
  // bridge, and immediately by /serve when it creates one, so a client that
  // connects at once already sees wired handlers.
  const wireBridge = (b: AppBridge) => {
    b.getAgents = () =>
      controller.tabs.map((t) => ({ id: t.id, name: t.name, cwd: t.engine.cwd, model: t.engine.modelId, mode: t.engine.mode, busy: t.busy }));
    b.onInput = (tabId, text) => {
      const tab = controller.byId(tabId) ?? controller.active();
      emitToTab(tab, { kind: "user", text });
      controller.submitUser(tab, text);
    };
    b.onCommand = (tabId, command) => {
      const tab = controller.byId(tabId);
      if (tab && tab.id !== controller.active().id) switchToTab(tab.id);
      handleCommand(command.startsWith("/") ? command.trim() : "/" + command.trim());
    };
    b.onCreateAgent = (name, purpose) => newTab(name, purpose ?? "");
    b.onCloseAgent = (tabId) => {
      const t = controller.byId(tabId);
      if (!t) return;
      if (t.id !== controller.active().id) switchToTab(t.id);
      closeActiveTab();
    };
    b.onFiles = (tabId, query) => rankedFiles(controller.byId(tabId)?.engine.cwd ?? controller.active().engine.cwd, query);
    // Goal bar: set/clear a tab's standing goal, then echo the new state back so
    // every client's bar stays in sync.
    b.onGoalSet = (tabId, goal) => {
      const tab = controller.byId(tabId) ?? controller.active();
      const g = tab.engine.setGoal(goal);
      b.bus.emit({ type: "goal.state", tabId: tab.id, goal: g });
    };
    b.onGoalClear = (tabId) => {
      const tab = controller.byId(tabId) ?? controller.active();
      tab.engine.clearGoal();
      b.bus.emit({ type: "goal.state", tabId: tab.id, goal: null });
    };
  };
  if (bridge) wireBridge(bridge);

  // `/serve [stop] [--port <n>]`: start/stop the localhost web view over THIS
  // running session (same event bus + engines, not a separate process). Already
  // running → reprint the URL; `stop` → shut down and clear the persistent line.
  const handleServe = async (arg: string) => {
    const toks = arg.split(/\s+/).filter(Boolean);
    if (toks[0] === "stop") {
      const cur = serveRef.current;
      if (!cur) return sysLog("serve: not running");
      await cur.handle.close();
      setServe(null);
      sysLog("serve stopped");
      return;
    }
    const pi = toks.indexOf("--port");
    const port = pi >= 0 && toks[pi + 1] ? Number(toks[pi + 1]) : undefined;
    if (port !== undefined && !Number.isInteger(port)) return sysLog("usage: /serve [stop] [--port <n>]");
    if (serveRef.current) {
      sysLog(`${g.diamond} serve  ${serveRef.current.url}  (already running)`);
      return;
    }
    // First /serve in a plain session: create the bus + bridge and attach them to
    // the already-running engines, then wire the client→server handlers.
    let b = bridgeRef.current;
    if (!b) {
      const bus = new EventBus();
      b = createBridge(bus);
      controller.attachBus(bus, b);
      wireBridge(b);
      bridgeRef.current = b;
      setBridge(b);
    }
    let handle: ServerHandle;
    try {
      handle = await startServer(b, { port });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") sysLog(`serve: port ${port ?? 7777} is already in use — try /serve --port <n>`);
      else sysLog(`serve: could not start — ${(e as Error).message}`);
      return;
    }
    setServe({ url: handle.url, handle });
    sysLog(`${g.diamond} serve  ${handle.url}`);
    sysLog("(127.0.0.1 only · token required · open it in a browser · /serve stop to shut down)");
  };

  // Bridge background-job lifecycle to the bus, and let a web answer dismiss the
  // TUI's permission overlay (the engine already resolved the shared request).
  useEffect(() => {
    if (!bridge) return;
    const tabIdFor = (owner: string | null) => (owner ? controller.byName(owner)?.id ?? null : null);
    const onStart = (j: Job) => bridge.bus.emit({ type: "job.start", tabId: tabIdFor(j.owner), jobId: j.id, command: j.command });
    const onDone = (j: Job) => bridge.bus.emit({ type: "job.end", tabId: tabIdFor(j.owner), jobId: j.id, status: j.status, exitCode: j.exitCode });
    jobs.on("start", onStart);
    jobs.on("done", onDone);
    const unsub = bridge.bus.subscribe((e) => {
      if (e.type === "permission.resolved" && overlayRef.current.type === "permission" && permOwnerRef.current === e.tabId) {
        resolvePerm(e.answer as PermissionAnswer);
      }
    });
    return () => {
      jobs.off("start", onStart);
      jobs.off("done", onDone);
      unsub();
    };
  }, [bridge]);

  // --- global keys ---------------------------------------------------------

  useInput((inp, key) => {
    if (key.ctrl && inp === "c") {
      // Second press within the 2s window: leave immediately, wedged or not.
      if (ctrlCArmedRef.current) {
        hardExit();
        return;
      }
      // A permission prompt is open: decline it and abort the turn. Keep the
      // queue (the turn is still "busy" here) rather than firing it on the abort.
      if (overlayRef.current.type === "permission") {
        flushSuppressedRef.current = true;
        abortedTurnRef.current = true; // user-initiated stop — don't notify on finish
        resolvePerm("no");
        engine.abort();
        armCtrlCExit();
        return;
      }
      // A turn (or a running tool) is in flight in the active tab: abort it, and
      // keep any queued input (ctrl+c preserves; esc is the discard gesture).
      if (busyRef.current) {
        flushSuppressedRef.current = true;
        abortedTurnRef.current = true; // user-initiated stop — don't notify on finish
        engine.abort();
        armCtrlCExit();
        return;
      }
      // A picker overlay is open: cancel it (clears the shared request so a web
      // client's mirror closes too) — no exit arming.
      if (overlayRef.current.type !== "none") {
        resolveOverlay(null);
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
    // Esc discards the type-ahead queue (only when no overlay owns Esc, and only
    // when there's actually a queue — otherwise let it fall through).
    if (key.escape && overlayRef.current.type === "none" && activeQueue().length) {
      clearQueue();
      return;
    }
    // Ctrl+R reverse-searches prompt history (this session + prior ones for this cwd).
    if (key.ctrl && inp === "r" && overlayRef.current.type === "none") {
      void openHistorySearch();
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
          onSelect={(v) => resolveOverlay(v)}
          onSave={(v) => saveOverlay(v)}
          saveHint="save as default"
          onCancel={() => resolveOverlay(null)}
        />
      );
    }
    if (overlay.type === "file") {
      return (
        <Picker
          caps={caps}
          width={inner}
          title="insert file path (fuzzy, repo-map ranked)"
          items={overlay.items}
          fuzzy
          onSelect={(v) => resolveOverlay(v)}
          onCancel={() => resolveOverlay(null)}
        />
      );
    }
    if (overlay.type === "history") {
      return (
        <Picker
          caps={caps}
          width={inner}
          title="reverse-search prompt history"
          items={overlay.items}
          onSelect={(v) => resolveOverlay(v)}
          onCancel={() => resolveOverlay(null)}
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
        onSelect={(id) => resolveOverlay(id)}
        onCancel={() => resolveOverlay(null)}
      />
    );
  };

  const tabInfos = controller.tabs.map((t) => ({
    name: t.name,
    active: t.id === controller.activeId,
    badge: t.badge,
    busy: t.busy,
  }));

  // The active tab's task list (the `todo` tool), rendered live above the input.
  // ○ pending, ◐ active, ● done — ASCII fallbacks on legacy terminals.
  const todos = engine.todos;
  const todoGlyph = (status: string) =>
    status === "done" ? (caps.legacy ? "[x]" : "●") : status === "active" ? (caps.legacy ? "[~]" : "◐") : caps.legacy ? "[ ]" : "○";
  const todoColor = (status: string) => (status === "done" ? C.dim : status === "active" ? C.cyan : C.value);

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
  const overlayRows =
    overlay.type === "permission"
      ? 8
      : overlay.type === "model" || overlay.type === "file" || overlay.type === "session" || overlay.type === "history"
        ? Math.min(overlay.items.length, 12) + 4
        : 0;
  let regionRows = 0;
  if (alt && altLayout) regionRows += altLayout.rows; // the split grid replaces the transient region
  else {
    if (pending) regionRows += 1;
    if (liveTool) regionRows += 1;
  }
  if (tabbarShown) regionRows += 2; // marginTop + tab bar
  regionRows += todos.length; // the todo panel (one row per task, above the status bar)
  regionRows += (tabbarShown ? 0 : 1) + 1; // status bar (+ its marginTop)
  if (ctrlCArmed) regionRows += 1;
  if (overlay.type !== "none") {
    regionRows += 1 + overlayRows; // marginTop + overlay
  } else {
    if (busy) regionRows += 1; // thinking spinner status line (above the input)
    regionRows += 1; // input line
    if (busy || input === "") regionRows += 1; // hint line (busy hint, or mode hint when empty)
    regionRows += queued.length; // dim queued-input lines
  }
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

      {/* The model's task list (todo tool): one row per task, above the status
          bar so it stays in view while a multi-step job runs. */}
      {todos.length ? (
        <Box flexDirection="column" width={inner}>
          {todos.map((t, i) => (
            <Text key={i} color={col(todoColor(t.status))} wrap="truncate">
              {todoGlyph(t.status)} {t.text}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Persistent web-view line while `/serve` (or `dom serve`) is running. */}
      {serve ? (
        <Box marginTop={tabbarShown ? 0 : 1} width={inner}>
          <Text color={col(C.cyan)} wrap="truncate">
            {g.diamond} serve  <Text color={col(C.value)}>{serve.url}</Text>
          </Text>
        </Box>
      ) : null}

      <Box marginTop={serve ? 0 : tabbarShown ? 0 : 1}>
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
      ) : (
        <>
          {/* A running turn shows the spinner as a status line ABOVE the input,
              which stays live so a follow-up can be typed and queued. */}
          {busy ? (
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
          ) : null}
          <InputBar
            caps={caps}
            width={inner}
            value={input}
            onChange={handleChange}
            onSubmit={handleSubmit}
            mode={engine.mode}
            autoApproveEdits={engine.autoApproveEdits}
            busy={busy}
          />
          {/* Queued type-ahead lines, dim, below the input. Present while a turn
              runs and (after a ctrl+c abort) until sent or cleared. */}
          {queued.length ? (
            <Box flexDirection="column" width={inner}>
              {queued.map((q, i) => (
                <Text key={i} color={col(C.dim)} wrap="truncate">
                  {g.mid} {q}
                </Text>
              ))}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
