// The MCP manager: one process-wide registry of connected servers. It owns the
// server connections, publishes their tools into dom's tool registry (namespaced
// mcp__<server>__<tool>), and exposes a connection snapshot for the CONNECTIONS
// tab. Tool calls flow back through each ToolDef's run closure into the server.

import { z } from "zod";
import type { ToolDef } from "../tools/index.js";
import { setMcpToolDefs } from "../tools/index.js";
import { loadMcpConfig, saveMcpConfig, type McpConfig } from "./config.js";
import { McpServer, type McpStatus } from "./client.js";

/** One server's state, as shown in the CONNECTIONS tab. */
export interface McpConnectionInfo {
  name: string;
  transport: string;
  status: McpStatus;
  toolCount: number;
  mutating: boolean;
  /** This server drives the real desktop — shown in CONNECTIONS so the flag is
   * visible where the server is, not just in mcp.json. */
  computerUse: boolean;
  /** Tools an allowlist is holding back (0 when the server has no allowlist), so
   * the tab shows "13 of 64" rather than implying 13 is all there is. */
  withheld: number;
  disabled: boolean;
  error: string | null;
  description: string;
  tools: { name: string; description: string }[];
}

/** Namespaced tool name for a server's tool: mcp__<server>__<tool>. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

class McpManager {
  private servers = new Map<string, McpServer>();
  private started = false;

  /** Load ~/.dom/mcp.json and connect every non-disabled server (in parallel,
   * best-effort), then publish their tools. Safe to call once at boot. */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const config = await loadMcpConfig();
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      this.servers.set(name, new McpServer(name, cfg));
    }
    await Promise.all([...this.servers.values()].map((s) => s.connect()));
    this.publish();
  }

  /** Enable or disable a server for this session: persists the flag to mcp.json,
   * connects or closes the process, and republishes tools. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const config = await loadMcpConfig();
    const cfg = config.mcpServers[name];
    if (!cfg) return;
    cfg.disabled = !enabled;
    await saveMcpConfig(config);

    let server = this.servers.get(name);
    if (!server) { server = new McpServer(name, cfg); this.servers.set(name, server); }
    server.config.disabled = !enabled;
    if (enabled) await server.connect();
    else await server.close();
    this.publish();
  }

  /** Snapshot for the CONNECTIONS tab. */
  connections(): McpConnectionInfo[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      transport: s.transport,
      status: s.status,
      toolCount: s.tools.length,
      mutating: s.mutating,
      computerUse: s.computerUse,
      withheld: s.withheld,
      disabled: s.config.disabled ?? false,
      error: s.error,
      description: s.config.description ?? "",
      tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
    }));
  }

  /** Build the ToolDef map for every connected server's tools and publish it into
   * the tool registry so the engine advertises + dispatches them. */
  private publish(): void {
    const defs: Record<string, ToolDef> = {};
    for (const server of this.servers.values()) {
      if (server.status !== "connected") continue;
      for (const tool of server.tools) {
        const name = mcpToolName(server.name, tool.name);
        const computerUse = server.computerUse;
        defs[name] = {
          name,
          description: computerUse
            ? `[MCP · ${server.name} · CONTROLS THE REAL DESKTOP] ${tool.description}`.trim()
            : `[MCP · ${server.name}] ${tool.description}`.trim(),
          // MCP tools carry a JSON Schema, not a zod schema — accept anything at the
          // dom layer (the server validates) and hand the real schema to the model.
          schema: z.any(),
          jsonSchema: tool.inputSchema,
          // A computer_use server's tools are mutating no matter what the config
          // says: none of them is read-only in any meaningful sense.
          mutating: computerUse || server.mutating,
          computerUse,
          source: "mcp",
          // Images the server returns (a screenshot) are attached to the next
          // message through the same channel view_image uses, so the model sees
          // the picture instead of a "[image image/png]" placeholder.
          run: async (args, _signal, ctx) => {
            const r = await server.callTool(tool.name, args);
            for (const img of r.images) ctx?.attachImage?.(img);
            return { output: r.output, isError: r.isError };
          },
        };
      }
    }
    setMcpToolDefs(defs);
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.close()));
    setMcpToolDefs({});
  }
}

/** Process-wide singleton. */
export const mcp = new McpManager();

export type { McpConfig };
