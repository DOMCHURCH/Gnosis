import { useEffect, useRef, useState, type ReactNode } from "react";
import { existsSync } from "node:fs";
import path from "node:path";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { Banner } from "./Banner.js";
import { StatusBar } from "./StatusBar.js";
import { SPINNER_FRAMES, ASCII_SPINNER, pickWord, formatElapsed } from "./thinking.js";
import { cycleApprovalMode } from "./modes.js";
import { InputBar } from "./InputBar.js";
import { Permission } from "./Permission.js";
import { Picker, type PickItem } from "./Picker.js";
import { C } from "./theme.js";
import type { Caps } from "./terminal.js";
import { Engine, type Callbacks } from "../engine.js";
import type { Preview, PermissionAnswer } from "../permissions.js";
import { TOOL_NAMES } from "../tools/index.js";
import { runGlob } from "../tools/glob.js";
import { fetchModels, type ModelEntry } from "../models.js";
import { getRepoInfo } from "../gitinfo.js";
import { undoLast, listCheckpoints } from "../checkpoint.js";
import { listSessions, loadConfig, loadSession, saveConfig, type Mode } from "../config.js";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

type Log =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "line"; text: string }
  | { id: number; kind: "rule"; lang: string }
  | { id: number; kind: "tool"; name: string; ok: boolean; summary: string }
  | { id: number; kind: "system"; text: string };

type Overlay =
  | { type: "none" }
  | { type: "permission"; preview: Preview }
  | { type: "model"; items: PickItem[] }
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
}

const HELP = [
  "commands:",
  "  /model [id]   switch model (no arg opens the picker)",
  "  /mode <ask|plan|yolo>   change permission mode",
  "  /skills       list loaded skills",
  "  /clear        clear the conversation",
  "  /compact      summarize and shrink history",
  "  /tools        list available tools",
  "  /cost         show token + dollar usage",
  "  /resume       resume a past session",
  "  /vault [set <path>]   switch working root to your Obsidian vault",
  "  /undo         revert dom's most recent file edit",
  "  /checkpoints  list recent dom checkpoints",
  "  /help         this help",
  "  /exit         quit",
  "  @             insert a file path    !cmd  run a shell command",
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
function useTermWidth(fallback: number): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || fallback);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns || fallback);
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, fallback]);
  return cols;
}

export function App({ engine, caps, width, ghAuth, initialRepo, skillWarnings }: Props) {
  const { exit } = useApp();
  const g = caps.glyphs;
  const col = (hex: string) => (caps.color ? hex : undefined);

  // The width every dynamic-region element is bounded by: two columns short of
  // the live terminal width, so nothing can touch the last column and wrap.
  const cols = useTermWidth(width);
  const inner = Math.max(24, cols - 2);

  const idRef = useRef(1);
  const nextId = () => idRef.current++;

  const [log, setLog] = useState<Log[]>(() => {
    const seed: Log[] = [{ id: 0, kind: "banner" }];
    for (const w of skillWarnings) seed.push({ id: idRef.current++, kind: "system", text: `! ${w}` });
    return seed;
  });
  const [input, setInput] = useState("");
  // The transient in-progress line (the streaming owner commits finished lines
  // straight to <Static>; this holds only the line still being typed).
  const [pending, setPending] = useState("");
  const [liveTool, setLiveTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Interactive boot opens the model picker before the first message, defaulted
  // to the config model (engine.modelId). Uses the catalog already fetched at
  // boot, so there's no async gap. Esc keeps the default; select switches.
  const [overlay, setOverlay] = useState<Overlay>({ type: "model", items: buildModelItems(engine.models) });
  const [repo, setRepo] = useState(initialRepo);
  // The working root all tools resolve against (== process.cwd()); /vault moves it.
  const [root, setRoot] = useState(engine.cwd);

  const busyRef = useRef(false);
  const inputRef = useRef("");
  inputRef.current = input;
  const overlayRef = useRef<Overlay>(overlay);
  overlayRef.current = overlay;
  const permResolveRef = useRef<((a: PermissionAnswer) => void) | null>(null);
  // Latest fetched catalog, for pricing lookups when confirming a switch.
  const modelsRef = useRef<ModelEntry[]>(engine.models);

  // Thinking spinner: a random playful word + live timer for the current turn.
  const frames = caps.legacy ? ASCII_SPINNER : SPINNER_FRAMES;
  const [think, setThink] = useState<{ word: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [spin, setSpin] = useState(0);
  // Bumped whenever the approval mode changes so the input hint re-renders.
  const [, setModeTick] = useState(0);

  // Ctrl+C is a two-step exit. The first press aborts the turn / clears state and
  // arms a 2-second window; a second press inside that window hard-exits (130).
  // This guarantees a way out even if a turn is wedged and won't abort cleanly.
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
    // Restore cooked input so the shell isn't left in raw mode, then exit now —
    // deliberately skipping Ink's async teardown, which is the point of the hatch.
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* stdin isn't a TTY */
    }
    process.exit(130);
  };

  useEffect(() => () => clearTimeout(ctrlCTimer.current ?? undefined), []);

  useEffect(() => {
    if (!busy) {
      setThink(null);
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

  const pushLog = (item: DistributiveOmit<Log, "id">) => setLog((l) => [...l, { id: nextId(), ...item } as Log]);
  const sysLog = (text: string) => pushLog({ kind: "system", text });

  const refreshRepo = () => {
    getRepoInfo(process.cwd()).then(setRepo).catch(() => {});
  };

  const stubCb = (): Callbacks => ({
    onLine: () => {},
    onPending: () => {},
    onAssistant: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onSystem: sysLog,
    requestPermission: async () => "no",
  });

  const buildCb = (): Callbacks => ({
    // Each finalized line commits straight to the <Static> transcript — that's the
    // single owner. The line still being typed lives only in `pending`, which is
    // at most one wrapped row tall, so Ink can always erase it.
    onLine: (line) =>
      pushLog(line.kind === "rule" ? { kind: "rule", lang: line.lang } : { kind: "line", text: line.text }),
    onPending: (text) => setPending(text),
    // Lines are already in the transcript; nothing more to render for the text.
    onAssistant: () => {},
    onToolStart: (call, args) => {
      const a = JSON.stringify(args);
      setLiveTool(`${call.name} ${a.length > 100 ? a.slice(0, 100) + "…" : a}`);
    },
    onToolResult: (call, result) => {
      setLiveTool(null);
      // A cancelled tool is aborted, not failed — render it dim, not as a red ✗.
      if (result.aborted) {
        pushLog({ kind: "system", text: `⎿ ${call.name} aborted` });
        return;
      }
      const summary = result.output.split("\n").slice(0, 6).join("\n");
      pushLog({ kind: "tool", name: call.name, ok: !result.isError, summary });
    },
    onSystem: sysLog,
    requestPermission: (preview) =>
      new Promise<PermissionAnswer>((resolve) => {
        permResolveRef.current = resolve;
        setOverlay({ type: "permission", preview });
      }),
  });

  const resolvePerm = (ans: PermissionAnswer) => {
    const r = permResolveRef.current;
    permResolveRef.current = null;
    setOverlay({ type: "none" });
    r?.(ans);
  };

  const runTurn = async (fn: (cb: Callbacks) => Promise<void>) => {
    setBusy(true);
    busyRef.current = true;
    setPending("");
    try {
      await fn(buildCb());
    } finally {
      setBusy(false);
      busyRef.current = false;
      // Clear the transient region. On abort the finalized lines already committed
      // to <Static> stay; only the unfinished partial (which lived here) is dropped.
      setPending("");
      setLiveTool(null);
      refreshRepo();
    }
  };

  // --- command handling ----------------------------------------------------

  // Move the working root. Every tool resolves paths against process.cwd(), so a
  // chdir is all that's needed — no tool changes.
  const switchRoot = (abs: string) => {
    try {
      process.chdir(abs);
    } catch (e) {
      sysLog(`vault: cannot switch to ${abs} — ${(e as Error).message}`);
      return;
    }
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

  const applyModel = (id: string) => {
    engine.setModel(id);
    // saveConfig read-merges, so apiKey and any other keys are preserved.
    void saveConfig({ model: id });
    void engine.persist();
    const m = modelsRef.current.find((x) => x.id === id);
    sysLog(`model ${g.chevron} ${id}${m ? `  ${priceLabel(m)}` : ""}`);
  };

  // /model <substring>: one match switches, several open the filtered picker,
  // none reports no match.
  const selectModelByArg = async (arg: string) => {
    const models = await fetchModels();
    modelsRef.current = models;
    const q = arg.toLowerCase();
    const exact = models.find((m) => m.id.toLowerCase() === q);
    if (exact) return applyModel(exact.id);
    const matches = models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
    if (matches.length === 1) applyModel(matches[0]!.id);
    else if (matches.length > 1) setOverlay({ type: "model", items: buildModelItems(matches) });
    else sysLog(`no model matches "${arg}"`);
  };

  const setModeCmd = (arg: string) => {
    if (arg !== "ask" && arg !== "plan" && arg !== "yolo") {
      sysLog(`usage: /mode <ask|plan|yolo>`);
      return;
    }
    engine.setMode(arg as Mode);
    void saveConfig({ mode: arg as Mode });
    void engine.persist();
    setModeTick((t) => t + 1);
    sysLog(`mode ${g.chevron} ${arg}`);
  };

  // shift+tab cycles: normal → auto-accept edits → yolo → normal.
  const cycleMode = () => {
    const next = cycleApprovalMode(engine.mode, engine.autoApproveEdits);
    engine.setMode(next.mode);
    engine.autoApproveEdits = next.autoApproveEdits;
    void saveConfig({ mode: next.mode });
    void engine.persist();
    setModeTick((t) => t + 1);
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
      case "cost":
        sysLog(
          `${engine.cost.promptTokens} in / ${engine.cost.completionTokens} out tokens · $${engine.cost.usd.toFixed(4)}`,
        );
        break;
      case "clear":
        engine.clear();
        setLog([{ id: nextId(), kind: "banner" }, { id: nextId(), kind: "system", text: "conversation cleared" }]);
        break;
      case "compact":
        engine.forceCompact(stubCb());
        break;
      case "mode":
        setModeCmd(arg);
        break;
      case "model":
        if (arg) void selectModelByArg(arg);
        else void openModelPicker();
        break;
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
      void runTurn((cb) => engine.runBashDirect(command, cb));
      return;
    }
    if (v.startsWith("/")) {
      handleCommand(v.trim());
      return;
    }
    pushLog({ kind: "user", text: v });
    void runTurn((cb) => engine.run(v, cb));
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
      // A turn (or a running tool) is in flight: abort it and kill the tool, then
      // return to the prompt. The abort signal now reaches the spawned process.
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
    // shift+tab cycles the approval mode when the input bar is active.
    if (key.tab && key.shift && overlayRef.current.type === "none" && !busyRef.current) {
      cycleMode();
    }
  });

  // --- render --------------------------------------------------------------

  const renderLog = (item: Log): ReactNode => {
    switch (item.kind) {
      case "banner":
        return <Banner caps={caps} width={width} modelId={engine.modelId} tools={TOOL_NAMES} ghAuth={ghAuth} />;
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
      case "tool":
        return (
          <Box flexDirection="column">
            <Text color={col(item.ok ? C.ok : C.danger)}>
              {item.ok ? "✓" : "✗"} {item.name}
            </Text>
            <Text color={col(C.dim)}>{item.summary.replace(/\n/g, "\n  ").replace(/^/, "  ")}</Text>
          </Box>
        );
      case "system":
        return <Text color={col(C.dim)}>{item.text}</Text>;
    }
  };

  const renderOverlay = (): ReactNode => {
    if (overlay.type === "permission") {
      return <Permission caps={caps} width={inner} preview={overlay.preview} onDecide={resolvePerm} />;
    }
    if (overlay.type === "model") {
      return (
        <Picker
          caps={caps}
          width={inner}
          title="select model"
          items={overlay.items}
          initialValue={engine.modelId}
          onSelect={(v) => {
            setOverlay({ type: "none" });
            applyModel(v);
          }}
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
            setLog([
              { id: nextId(), kind: "banner" },
              { id: nextId(), kind: "system", text: `resumed ${id} (${s.messages.length} messages)` },
            ]);
            refreshRepo();
          });
        }}
        onCancel={() => setOverlay({ type: "none" })}
      />
    );
  };

  return (
    <Box flexDirection="column">
      <Static items={log}>{(item) => <Box key={item.id}>{renderLog(item)}</Box>}</Static>

      {pending ? (
        <Box width={inner}>
          <Text color={col(C.value)} wrap="truncate-start">
            {pending}
          </Text>
        </Box>
      ) : null}
      {liveTool ? (
        <Box width={inner}>
          <Text color={col(C.dim)} wrap="truncate">
            {g.mid} {liveTool}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <StatusBar
          caps={caps}
          width={inner}
          cwd={root}
          branch={repo.branch}
          dirtyCount={repo.dirtyCount}
          modelName={engine.currentModel()?.name ?? engine.modelId}
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
