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

/** Resolve the API key: environment wins, then config. */
export function resolveApiKey(config: Config): string | undefined {
  return process.env.OPENROUTER_API_KEY || config.apiKey;
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
