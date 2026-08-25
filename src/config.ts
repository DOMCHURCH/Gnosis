// ~/.dom persistence: config, model cache, sessions.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Msg } from "./messages.js";

export type Mode = "ask" | "plan" | "yolo";

export interface Config {
  model?: string;
  /** Model to switch to for the rest of the session when the active model 404s or
   * hits an upstream/shared-pool 429 that won't clear on retry (e.g. a free model). */
  fallbackModel?: string;
  mode?: Mode;
  apiKey?: string;
  /** Absolute path to an Obsidian vault; `/vault` switches the working root here. */
  obsidianVault?: string;
  /** Groq API key; enables native routing for `groq/`-prefixed models. */
  groqApiKey?: string;
  /** Commit every successful write/edit to the current repo (default true). The
   * `--no-auto-commit` flag overrides this off for a session. */
  autoCommit?: boolean;
  /** Token budget for the repo map injected into the system prompt (default 1024). */
  mapTokens?: number;
  /** Desktop notification (with terminal-bell fallback) when a turn finishes or
   * needs approval. Default true. */
  notify?: boolean;
  /** Stronger model the `oracle` tool consults for hard sub-problems. Falls back
   * to the session model when unset. */
  oracleModel?: string;
  /** Shell command run after an editing turn when autoFix is on (e.g. "npm run lint"). */
  lintCommand?: string;
  /** Shell command run after an editing turn when autoFix is on (e.g. "npm test"). */
  testCommand?: string;
  /** Enable the auto lint/test loop: after a turn that edited files, run
   * lint/test; feed any failure back so the model retries (cap 3). Default off. */
  autoFix?: boolean;
  /** Legacy name for autoEval — still honoured so existing configs keep working. */
  autoVerify?: boolean;
  /** Automatic outcome evaluation: after ANY turn that touched files, a read-only
   * verifier judges the diff against the request and reports pass/fail with a
   * confidence. Default ON; /eval always triggers it manually. */
  autoEval?: boolean;
  /** When an outcome evaluation FAILS, feed its critique back as the next turn
   * automatically instead of waiting to be asked. Default off. */
  autoFixOutcome?: boolean;
  /** Automatic session memory: after each file-touching turn, distill what happened
   * into the learned-context bank (~/.dom/memory). Default ON; set false to disable. */
  autoMemory?: boolean;
  /** Small, fast model used for the automatic-memory distillation pass. Falls back
   * to the session model when unset. */
  memoryModel?: string;
  /** LSP Lite: after a turn that edits code, run the language's type checker
   * (tsc/mypy/cargo check) and feed any errors back so the model fixes them unasked.
   * Default ON; runs only when the matching project marker is present. */
  lspCheck?: boolean;
  /** Dollar ceiling per session. On reaching it dom halts the turn, refuses new
   * sub-agent/oracle spawns, and prompts to continue or stop. Default 2. */
  maxSessionUsd?: number;
  /** Extra workspace roots (multi-root): grep/glob without a path search cwd plus
   * these. Also addable at runtime with /workspace add <path>. */
  workspaceRoots?: string[];
}

export interface CostState {
  promptTokens: number;
  /** Of promptTokens, how many were served from the provider's prompt cache
   * (billed at a fraction of the input price). Uncached = promptTokens - this. */
  cachedPromptTokens: number;
  completionTokens: number;
  usd: number;
  /** Of usd, the portion spent by `task` sub-agents (shown separately in /cost). */
  subAgentUsd?: number;
  /** Per-sub-agent dollar attribution, in the order the sub-agents were spawned.
   * A coordinated task appends one entry per parallel sub-agent; a plain task
   * appends a single entry. Drives the per-sub-agent breakdown in /cost. */
  subAgents?: { label: string; usd: number }[];
  /** Of usd, the portion spent by the `oracle` tool (shown separately in /cost). */
  oracleUsd?: number;
}

export type TodoStatus = "pending" | "active" | "done";

/** One entry in the model-maintained task list (the `todo` tool). */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export interface SessionData {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: Mode;
  cost: CostState;
  summary: string | null;
  messages: Msg[];
  /** The model's current task list, persisted per session (the `todo` tool). */
  todos?: TodoItem[];
}

export function domDir(): string {
  return path.join(os.homedir(), ".dom");
}
export function configPath(): string {
  return path.join(domDir(), "config.json");
}
/** ~/.dom/.env — one file for every key: HTTP tool secrets, BRAVE_API_KEY, and
 * the OpenRouter key (see resolveApiKey). */
export function envPath(): string {
  return path.join(domDir(), ".env");
}
export function sessionsDir(): string {
  return path.join(domDir(), "sessions");
}
export function skillsDir(): string {
  return path.join(domDir(), "skills");
}
/** ~/.dom/cache — a tool-accessible pocket of ~/.dom for skill data caches
 * (e.g. the public-apis index). Managed by code; readable/greppable by tools. */
export function cacheDir(): string {
  return path.join(domDir(), "cache");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function loadConfig(): Promise<Config> {
  try {
    const txt = await fs.readFile(configPath(), "utf8");
    return JSON.parse(txt) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<void> {
  await ensureDir(domDir());
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
}

/** Parse ~/.dom/.env (KEY=value lines, # comments, optional quotes). Shared by
 * the http/web_search tools and OpenRouter key resolution — one file for all keys. */
export async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  let txt: string;
  try {
    txt = await fs.readFile(envPath(), "utf8");
  } catch {
    return env; // absent — nothing to contribute
  }
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) env[k] = v;
  }
  return env;
}

/** Resolve the OpenRouter API key. Precedence: process.env, then ~/.dom/.env,
 * then the config.json apiKey field. undefined if none set. */
export async function resolveApiKey(config: Config): Promise<string | undefined> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = await loadEnv();
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  return config.apiKey;
}

/** ~/.dom/AGENTS.md — the global agent-instructions file, also scanned for a
 * vault directive (see resolveVaultPath). */
export function globalAgentsPath(): string {
  return path.join(domDir(), "AGENTS.md");
}

// A vault directive in AGENTS.md: `vault: <path>` or `obsidian vault: <path>`
// (case-insensitive, `:` or `=`, optional surrounding quotes/backticks).
const VAULT_DIRECTIVE_RE = /^\s*(?:obsidian\s+)?vault\s*[:=]\s*(.+?)\s*$/im;

/** Resolve the Obsidian vault path. Precedence: config.obsidianVault, then a
 * `vault:` directive in ~/.dom/AGENTS.md. Returns an absolute path (existence
 * NOT checked — the caller decides), or undefined when none is configured. */
export async function resolveVaultPath(config: Config): Promise<string | undefined> {
  if (config.obsidianVault) return path.resolve(config.obsidianVault);
  let txt: string;
  try {
    txt = await fs.readFile(globalAgentsPath(), "utf8");
  } catch {
    return undefined; // no global AGENTS.md
  }
  const m = txt.match(VAULT_DIRECTIVE_RE);
  if (!m) return undefined;
  let raw = m[1]!.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith("`") && raw.endsWith("`"))) {
    raw = raw.slice(1, -1);
  }
  raw = raw.replace(/^~(?=[/\\]|$)/, os.homedir());
  return raw ? path.resolve(raw) : undefined;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function newId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${stamp}-${rand}`;
}

export function createSession(cwd: string, model: string, mode: Mode): SessionData {
  const now = Date.now();
  return {
    id: newId(),
    cwd,
    createdAt: now,
    updatedAt: now,
    model,
    mode,
    cost: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, usd: 0, subAgentUsd: 0 },
    summary: null,
    messages: [],
  };
}

export async function saveSession(s: SessionData): Promise<void> {
  await ensureDir(sessionsDir());
  s.updatedAt = Date.now();
  await fs.writeFile(path.join(sessionsDir(), `${s.id}.json`), JSON.stringify(s, null, 2), "utf8");
}

export async function loadSession(id: string): Promise<SessionData | null> {
  try {
    const txt = await fs.readFile(path.join(sessionsDir(), `${id}.json`), "utf8");
    return JSON.parse(txt) as SessionData;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionData[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const out: SessionData[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const s = JSON.parse(await fs.readFile(path.join(sessionsDir(), n), "utf8")) as SessionData;
      out.push(s);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function latestSessionForCwd(cwd: string): Promise<SessionData | null> {
  const all = await listSessions();
  return all.find((s) => s.cwd === cwd) ?? null;
}
