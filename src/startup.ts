// Shared boot path for both the headless runner and the Ink UI.

import { Engine } from "./engine.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadSkills } from "./skills.js";
import { ensurePublicApisCache } from "./publicapis.js";
import { fetchModels } from "./models.js";
import type { ModelInfo } from "./provider.js";
import {
  createSession,
  latestSessionForCwd,
  loadConfig,
  loadSession,
  resolveApiKey,
  type Config,
  type Mode,
  type SessionData,
} from "./config.js";

export interface Flags {
  headless: boolean;
  yolo: boolean;
  resumeLatest: boolean;
  resumeId?: string;
  model?: string;
  prompt?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = { headless: false, yolo: false, resumeLatest: false, help: false, version: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--yolo":
        flags.yolo = true;
        break;
      case "--headless":
        flags.headless = true;
        break;
      case "-c":
      case "--continue":
        flags.resumeLatest = true;
        break;
      case "-r":
      case "--resume":
        flags.resumeId = argv[++i];
        break;
      case "--model":
      case "-m":
        flags.model = argv[++i];
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-v":
      case "--version":
        flags.version = true;
        break;
      default:
        positional.push(a);
    }
  }
  if (positional.length) flags.prompt = positional.join(" ");
  return flags;
}

// The active model comes from ~/.dom/config.json; absent, we default to a fast,
// cheap, tool-capable model rather than a premium one.
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

function pickDefaultModel(config: Config): string {
  return config.model ?? DEFAULT_MODEL;
}

export interface Boot {
  engine: Engine;
  models: ModelInfo[];
  config: Config;
  resumed: boolean;
  /** The configured default model (config.model ?? built-in default) — the status
   * bar marks divergence when the live session model differs from this. */
  defaultModel: string;
  /** Non-fatal skill-loading warnings (malformed SKILL.md, cap hit, ...). */
  skillWarnings: string[];
}

export class BootError extends Error {}

export async function boot(flags: Flags, cwd: string): Promise<Boot> {
  const config = await loadConfig();
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new BootError(
      "No OpenRouter API key found.\n" +
        "Set OPENROUTER_API_KEY in your environment, or add { \"apiKey\": \"sk-or-...\" } to ~/.dom/config.json.",
    );
  }

  // The catalog is public and self-healing (fetchModels never throws); it feeds
  // the picker, the context meter, and per-token cost fallback.
  const models: ModelInfo[] = (await fetchModels()).map((e) => ({
    id: e.id,
    name: e.name,
    context_length: e.context_length,
    pricing: { prompt: e.pricing.prompt, completion: e.pricing.completion },
    supported_parameters: e.supported_parameters,
  }));

  const defaultModel = pickDefaultModel(config);
  const mode: Mode = flags.yolo ? "yolo" : config.mode ?? "ask";

  let session: SessionData | null = null;
  let resumed = false;
  if (flags.resumeId) {
    session = await loadSession(flags.resumeId);
    if (!session) throw new BootError(`No session with id ${flags.resumeId}`);
    resumed = true;
  } else if (flags.resumeLatest) {
    session = await latestSessionForCwd(cwd);
    if (session) resumed = true;
  }
  if (!session) session = createSession(cwd, defaultModel, mode);

  if (flags.model) session.model = flags.model;
  if (flags.yolo) session.mode = "yolo";

  // Skills are parsed frontmatter-only and advertised in the system prompt; the
  // model reads a SKILL.md body on demand. Loading never throws — malformed files
  // become warnings.
  const { skills, warnings: skillWarnings } = await loadSkills(cwd);
  const systemPrompt = await buildSystemPrompt(cwd, skills);
  const engine = new Engine({ apiKey, cwd, systemPrompt, models, session, skills, fallbackModel: config.fallbackModel });

  // Warm the public-apis index in the background when that skill is installed and
  // we're interactive (skip in headless/CI). Best-effort, non-blocking, refreshes
  // at most once every 30 days; ensurePublicApisCache never throws.
  if (!flags.headless && skills.some((s) => s.name === "public-apis")) {
    void ensurePublicApisCache().catch(() => {});
  }

  return { engine, models, config, resumed, defaultModel, skillWarnings };
}
