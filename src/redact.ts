// Secret redaction: scan text for well-known credential patterns and replace each
// with <redacted:TYPE>. Used on tool RESULTS and on the model's tool-call args
// before they reach the model, the transcript, or the session file — never on the
// bytes actually executed, so a redacted display can't break a real command.
//
// Patterns are deliberately specific (known prefixes/shapes) to avoid mangling
// ordinary output; we accept some misses over lots of false positives.

interface Pattern {
  type: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { type: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: "api-key", re: /\bsk-(?:or-|ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/g }, // OpenAI/OpenRouter/Anthropic/Stripe-ish
  { type: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github-token", re: /\b(?:gh[posru]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g },
];

// Bearer / Authorization tokens: keep the "Bearer " prefix, redact the token.
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

export function redactSecrets(text: string): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const p of PATTERNS) {
    out = out.replace(p.re, () => {
      count++;
      return `<redacted:${p.type}>`;
    });
  }
  out = out.replace(BEARER, (_m, prefix: string) => {
    count++;
    return `${prefix}<redacted:bearer-token>`;
  });
  return { text: out, count };
}
