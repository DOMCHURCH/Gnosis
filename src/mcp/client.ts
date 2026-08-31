// A single MCP server connection over stdio. Wraps the official SDK Client +
// StdioClientTransport: connect (with a timeout), list tools, call a tool, close.
// Status is tracked so the CONNECTIONS tab can show connected / error / disabled.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import type { ImagePart } from "../messages.js";
import { resolveServerEnv } from "./config.js";
import { launcherProblem } from "./runtime.js";

export type McpStatus = "disabled" | "connecting" | "connected" | "error";

/** A tool call's result: dom's ToolResult shape plus any images the server
 * returned (a screenshot, a cropped region), which the caller attaches to the
 * next message so the model can actually see them. */
export interface McpCallResult {
  output: string;
  isError: boolean;
  images: ImagePart[];
}

/** Result of narrowing a server's tools to its allowlist. */
export interface AllowlistResult {
  tools: McpTool[];
  /** How many the allowlist withheld (for the CONNECTIONS tab). */
  withheld: number;
  /** Allowlist entries that match no tool this server offers — almost always a
   * typo or a name from a different server, and silently dropping a capability
   * is worse than saying so. */
  unmatched: string[];
}

/**
 * Narrow a server's tools to its allowlist. No allowlist (or an empty one) means
 * publish everything — the default for every server that had no such field.
 */
export function applyAllowlist(tools: McpTool[], allow?: string[]): AllowlistResult {
  if (!allow || allow.length === 0) return { tools, withheld: 0, unmatched: [] };
  const wanted = new Set(allow);
  const kept = tools.filter((t) => wanted.has(t.name));
  const offered = new Set(tools.map((t) => t.name));
  return { tools: kept, withheld: tools.length - kept.length, unmatched: allow.filter((a) => !offered.has(a)) };
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (passed to the model verbatim). */
  inputSchema: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 20_000;

export class McpServer {
  readonly name: string;
  readonly config: McpServerConfig;
  status: McpStatus;
  /** The tools PUBLISHED to the model — already narrowed by allowTools. */
  tools: McpTool[] = [];
  /** How many the allowlist held back, and which entries matched nothing. */
  withheld = 0;
  unmatchedAllow: string[] = [];
  error: string | null = null;
  private client: Client | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
    this.status = config.disabled ? "disabled" : "connecting";
  }

  get mutating(): boolean {
    // Desktop control is never read-only, whatever the config says.
    return this.config.mutating ?? this.computerUse;
  }
  get computerUse(): boolean {
    return this.config.computer_use ?? false;
  }
  get transport(): string {
    return this.config.transport ?? "stdio";
  }

  /** Spawn + handshake + list tools. Best-effort: on failure the server is left
   * in "error" status with a message; it never throws to the caller. */
  async connect(): Promise<void> {
    if (this.config.disabled) {
      this.status = "disabled";
      return;
    }
    this.status = "connecting";
    this.error = null;

    // Check the launcher exists BEFORE trying to spawn it. Without this the
    // failure surfaces as the OS's own "spawn npx ENOENT" on every server at
    // once, which is what a fresh install shows on a machine with no Node.js —
    // technically accurate and completely unactionable. See mcp/runtime.ts.
    const problem = launcherProblem(this.config.command);
    if (problem) {
      this.status = "error";
      this.error = problem;
      return;
    }

    try {
      const env = await resolveServerEnv(this.config);
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env,
        stderr: "ignore",
      });
      const client = new Client({ name: "gnosis", version: "1.2.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect timed out");
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "listTools timed out");
      const offered = (listed.tools ?? []).map((t: any) => ({
        name: String(t.name),
        description: String(t.description ?? ""),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
      const narrowed = applyAllowlist(offered, this.config.allowTools);
      this.tools = narrowed.tools;
      this.withheld = narrowed.withheld;
      this.unmatchedAllow = narrowed.unmatched;
      // An allowlist entry that matches nothing removes a capability the user
      // thought they had granted. Say so rather than letting it fail silently at
      // the moment the model reaches for it.
      if (narrowed.unmatched.length) {
        process.stderr.write(
          `[33m! mcp ${this.name}: allowTools names no such tool: ${narrowed.unmatched.join(", ")}[0m
`,
        );
      }
      this.client = client;
      this.status = "connected";
    } catch (e) {
      this.status = "error";
      this.error = (e as Error)?.message ?? String(e);
      try { await this.client?.close(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  /** Call one of this server's tools. Returns a text result + error flag, matching
   * dom's ToolResult shape. */
  async callTool(toolName: string, args: unknown): Promise<McpCallResult> {
    if (!this.client || this.status !== "connected") {
      return { output: `MCP server "${this.name}" is not connected (${this.status}).`, isError: true, images: [] };
    }
    try {
      // Browser ops (navigate, screenshot) can outlast the SDK's 60s default.
      const res: any = await this.client.callTool(
        { name: toolName, arguments: (args as Record<string, unknown>) ?? {} },
        undefined,
        { timeout: 120_000 },
      );
      const { text, images } = splitContent(res?.content);
      return {
        output: text || (res?.isError ? "tool returned an error with no content" : images.length ? "" : "(no content)"),
        isError: !!res?.isError,
        images,
      };
    } catch (e) {
      return { output: `${this.name}.${toolName}: ${(e as Error).message}`, isError: true, images: [] };
    }
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* ignore */ }
    this.client = null;
    if (this.status === "connected") this.status = "disabled";
  }
}

/**
 * Split MCP content blocks into text and images.
 *
 * Image blocks used to flatten to the literal string "[image image/png]" and the
 * bytes were dropped on the floor — so a screenshot tool returned a placeholder
 * the model could not actually see. They now come back as ImageParts, which the
 * tool layer hands to the same attach-to-next-message path `view_image` uses.
 */
export function splitContent(content: unknown): { text: string; images: ImagePart[] } {
  if (!Array.isArray(content)) return { text: "", images: [] };
  const parts: string[] = [];
  const images: ImagePart[] = [];
  for (const c of content as any[]) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "image" && typeof c.data === "string") {
      images.push({ source: `mcp:image-${images.length + 1}`, mime: String(c.mimeType ?? "image/png"), data: c.data });
      parts.push(`[image ${c.mimeType ?? ""} — attached to the next message]`);
    } else if (c?.type === "image") parts.push(`[image ${c.mimeType ?? ""}]`);
    else if (c?.type === "resource") parts.push(`[resource ${c.resource?.uri ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  return { text: parts.join(String.fromCharCode(10)), images };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
