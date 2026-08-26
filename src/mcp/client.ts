// A single MCP server connection over stdio. Wraps the official SDK Client +
// StdioClientTransport: connect (with a timeout), list tools, call a tool, close.
// Status is tracked so the CONNECTIONS tab can show connected / error / disabled.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import { resolveServerEnv } from "./config.js";

export type McpStatus = "disabled" | "connecting" | "connected" | "error";

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
  tools: McpTool[] = [];
  error: string | null = null;
  private client: Client | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
    this.status = config.disabled ? "disabled" : "connecting";
  }

  get mutating(): boolean {
    return this.config.mutating ?? false;
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
    try {
      const env = await resolveServerEnv(this.config);
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env,
        stderr: "ignore",
      });
      const client = new Client({ name: "gnosis", version: "1.1.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect timed out");
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "listTools timed out");
      this.tools = (listed.tools ?? []).map((t: any) => ({
        name: String(t.name),
        description: String(t.description ?? ""),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
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
  async callTool(toolName: string, args: unknown): Promise<{ output: string; isError: boolean }> {
    if (!this.client || this.status !== "connected") {
      return { output: `MCP server "${this.name}" is not connected (${this.status}).`, isError: true };
    }
    try {
      // Browser ops (navigate, screenshot) can outlast the SDK's 60s default.
      const res: any = await this.client.callTool(
        { name: toolName, arguments: (args as Record<string, unknown>) ?? {} },
        undefined,
        { timeout: 120_000 },
      );
      const text = flattenContent(res?.content);
      return { output: text || (res?.isError ? "tool returned an error with no content" : "(no content)"), isError: !!res?.isError };
    } catch (e) {
      return { output: `${this.name}.${toolName}: ${(e as Error).message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* ignore */ }
    this.client = null;
    if (this.status === "connected") this.status = "disabled";
  }
}

/** Flatten MCP content blocks (text / image / resource) into a single string. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "image") parts.push(`[image ${c.mimeType ?? ""}]`);
    else if (c?.type === "resource") parts.push(`[resource ${c.resource?.uri ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  return parts.join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
