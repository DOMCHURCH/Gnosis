// Prompt history for the Ctrl+R reverse-search: prior user prompts from the
// current session (newest first) then from prior sessions for the same cwd,
// de-duplicated. Inter-agent relay messages ("[message from …]") are excluded.

import type { Msg } from "./messages.js";
import type { SessionData } from "./config.js";

export function gatherPromptHistory(opts: {
  currentMessages: Msg[];
  currentSessionId: string;
  sessions: SessionData[];
  cwd: string;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (text: string) => {
    const s = text.trim();
    if (!s || seen.has(s) || s.startsWith("[message from ")) return;
    seen.add(s);
    out.push(s);
  };
  const addFrom = (messages: Msg[]) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user") add(m.text);
    }
  };
  addFrom(opts.currentMessages);
  for (const s of opts.sessions) {
    if (s.cwd !== opts.cwd || s.id === opts.currentSessionId) continue;
    addFrom(s.messages);
  }
  return out;
}
