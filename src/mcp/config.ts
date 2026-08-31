// MCP configuration: ~/.dom/mcp.json holds the server registry, in the standard
// `mcpServers` shape used by other MCP hosts, plus two dom-specific fields:
// `mutating` (gate this server's tool calls through the permission system) and
// `disabled` (skip it this session). Env values may reference ${VAR} — resolved
// from ~/.dom/.env at connect time so secrets never live in mcp.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { domDir, loadEnv } from "../config.js";

export interface McpServerConfig {
  /** Executable to spawn (e.g. "npx"). stdio transport only, for now. */
  command: string;
  args?: string[];
  /** Extra env for the server process; values may use ${VAR} from ~/.dom/.env. */
  env?: Record<string, string>;
  transport?: "stdio";
  /** Gate this server's tool calls through the permission system (default false). */
  mutating?: boolean;
  /** This server drives the real desktop (mouse, keyboard, screen). Every tool it
   * publishes is treated as DANGEROUS by the permission gate: it prompts by
   * default, in every mode, including yolo. A deliberate "always" silences the
   * whole server for the session (the approval is keyed on the server, since one
   * "click that" turn fires four different tools). Marking a server computer_use
   * also forces `mutating`, since none of it is read-only in any meaningful
   * sense — a screenshot reads the user's entire screen. */
  computer_use?: boolean;
  /** Skip this server this session. */
  disabled?: boolean;
  /** When present, ONLY these tool names are published to the model; everything
   * else the server offers is never advertised and cannot be called. Absent (or
   * empty) publishes everything, which stays the default for ordinary servers.
   * The point is reach, not etiquette: a desktop-control server ships a script
   * runner, a filesystem tool and a registry editor alongside the mouse, and an
   * allowlist is what keeps those out of the model's hands entirely rather than
   * relying on it to behave. */
  allowTools?: string[];
  /** One-line human description (shown in the CONNECTIONS tab). */
  description?: string;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function mcpConfigPath(): string {
  return path.join(domDir(), "mcp.json");
}

/** The servers dom ships with, written to ~/.dom/mcp.json on first run. */
export function defaultMcpConfig(): McpConfig {
  return {
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        transport: "stdio",
        mutating: false,
        description: "live library documentation (context7.com)",
      },
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp", "--headless"],
        transport: "stdio",
        mutating: true,
        description: "browser automation and end-to-end testing",
      },
      "chrome-devtools": {
        command: "npx",
        args: ["-y", "chrome-devtools-mcp", "--headless"],
        transport: "stdio",
        mutating: true,
        description: "live browser inspection",
      },
      // Voice mode's "click/type for me" flow calls this server directly (see
      // VOICE-UI-ISSUES.md #4). Without it in the default registry, a fresh
      // install has voice input working but every computer-use action silently
      // has no tool to call — omitted here for a long time, matching this dev
      // machine's manually-added ~/.dom/mcp.json rather than what ships.
      "computer-use": {
        command: "npx",
        args: ["-y", "@zavora-ai/computer-use-mcp"],
        transport: "stdio",
        computer_use: true,
        description: "cross-platform desktop control (screenshot, mouse, keyboard, clipboard)",
        allowTools: [
          "screenshot",
          "get_frontmost_app",
          "list_windows",
          "get_window",
          "mouse_move",
          "left_click",
          "right_click",
          "double_click",
          "scroll",
          "type",
          "key",
        ],
      },
    },
  };
}

/** Read ~/.dom/mcp.json. Missing/invalid → empty registry (never throws). */
export async function loadMcpConfig(): Promise<McpConfig> {
  try {
    const txt = await fs.readFile(mcpConfigPath(), "utf8");
    const parsed = JSON.parse(txt) as McpConfig;
    if (parsed && typeof parsed === "object" && parsed.mcpServers) return parsed;
  } catch {
    /* absent or malformed — treat as empty */
  }
  return { mcpServers: {} };
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  await fs.mkdir(domDir(), { recursive: true });
  await fs.writeFile(mcpConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Write the default registry if ~/.dom/mcp.json doesn't exist yet. Returns true
 * when it created the file. Existing configs are left untouched. */
export async function ensureMcpConfig(): Promise<boolean> {
  try {
    await fs.access(mcpConfigPath());
    return false;
  } catch {
    await saveMcpConfig(defaultMcpConfig());
    return true;
  }
}

/** Resolve a server's `env`, substituting ${VAR} from ~/.dom/.env. */
export async function resolveServerEnv(cfg: McpServerConfig): Promise<Record<string, string> | undefined> {
  if (!cfg.env) return undefined;
  const secrets = await loadEnv();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => secrets[name] ?? process.env[name] ?? "");
  }
  return out;
}
