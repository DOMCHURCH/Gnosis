// Built-in webhook inspector for `dom serve`: POST /webhook/:label captures any
// payload into an in-memory ring buffer (last 100 per label, each body capped at
// 50KB) so you can inspect and replay webhooks without a separate ngrok window.
// In-memory only — nothing is persisted; the buffer dies with the server.

export interface WebhookEntry {
  id: string;
  label: string;
  method: string;
  contentType: string;
  headers: Record<string, string>;
  /** Stored body (truncated to MAX_BODY bytes). */
  body: string;
  /** Original body size in bytes (before truncation). */
  size: number;
  truncated: boolean;
  /** HTTP status the inspector returned to the sender. */
  statusReturned: number;
  receivedAt: number;
}

export const MAX_PER_LABEL = 100;
export const MAX_BODY = 50 * 1024; // 50KB per payload

export interface RecordInput {
  label: string;
  method: string;
  contentType?: string;
  headers?: Record<string, string>;
  body: string;
  statusReturned?: number;
  now?: number;
}

class WebhookStore {
  private byLabel = new Map<string, WebhookEntry[]>();
  private seq = 0;

  /** Store one received webhook and return its entry (newest for its label). */
  record(input: RecordInput): WebhookEntry {
    const size = Buffer.byteLength(input.body ?? "", "utf8");
    const truncated = size > MAX_BODY;
    const body = truncated ? Buffer.from(input.body, "utf8").subarray(0, MAX_BODY).toString("utf8") : (input.body ?? "");
    const entry: WebhookEntry = {
      id: `w${++this.seq}`,
      label: input.label || "default",
      method: (input.method || "POST").toUpperCase(),
      contentType: input.contentType || "",
      headers: input.headers ?? {},
      body,
      size,
      truncated,
      statusReturned: input.statusReturned ?? 200,
      receivedAt: input.now ?? Date.now(),
    };
    const list = this.byLabel.get(entry.label) ?? [];
    list.push(entry);
    if (list.length > MAX_PER_LABEL) list.splice(0, list.length - MAX_PER_LABEL); // drop oldest
    this.byLabel.set(entry.label, list);
    return entry;
  }

  /** Every stored webhook across all labels, newest first. */
  list(): WebhookEntry[] {
    const all: WebhookEntry[] = [];
    for (const list of this.byLabel.values()) all.push(...list);
    return all.sort((a, b) => b.receivedAt - a.receivedAt);
  }

  get(id: string): WebhookEntry | undefined {
    for (const list of this.byLabel.values()) {
      const found = list.find((e) => e.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** Distinct labels seen (for the UI's label list). */
  labels(): string[] {
    return [...this.byLabel.keys()];
  }

  clear(): void {
    this.byLabel.clear();
  }
}

export const webhooks = new WebhookStore();
