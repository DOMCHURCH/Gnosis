// Verify (webhook inspector): the ring buffer stores captured webhooks (last 100
// per label, each body capped at 50KB), lists them newest-first across labels,
// looks them up by id, tracks distinct labels, and clears.
import { webhooks, MAX_PER_LABEL, MAX_BODY } from "../dist/webhooks.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

webhooks.clear();
ok("starts empty", webhooks.list().length === 0);

const a = webhooks.record({ label: "stripe", method: "post", contentType: "application/json", body: '{"id":1}', now: 1000 });
const b = webhooks.record({ label: "github", method: "POST", body: "ping", now: 2000 });
ok("record returns an entry with an id", !!a.id && a.id !== b.id);
ok("method is upper-cased", a.method === "POST");
ok("size is the byte length of the body", a.size === Buffer.byteLength('{"id":1}'));
ok("statusReturned defaults to 200", a.statusReturned === 200);

const list = webhooks.list();
ok("list has both entries", list.length === 2);
ok("list is newest-first", list[0].id === b.id && list[1].id === a.id);
ok("get looks up by id", webhooks.get(a.id)?.label === "stripe");
ok("get returns undefined for an unknown id", webhooks.get("nope") === undefined);
ok("labels lists the distinct labels", webhooks.labels().sort().join(",") === "github,stripe");

// 50KB body truncation
const big = "x".repeat(MAX_BODY + 5000);
const t = webhooks.record({ label: "big", body: big });
ok("an oversized body is flagged truncated", t.truncated === true);
ok("the stored body is capped at MAX_BODY bytes", Buffer.byteLength(t.body) === MAX_BODY);
ok("the reported size is the ORIGINAL byte length", t.size === Buffer.byteLength(big));

// 100-per-label cap (oldest dropped)
webhooks.clear();
for (let i = 0; i < MAX_PER_LABEL + 20; i++) webhooks.record({ label: "flood", body: String(i), now: i });
const flood = webhooks.list().filter((w) => w.label === "flood");
ok("per-label buffer is capped at 100", flood.length === MAX_PER_LABEL);
ok("the oldest entries were dropped (kept the newest 100)", flood.every((w) => Number(w.body) >= 20));

webhooks.clear();
ok("clear empties the buffer", webhooks.list().length === 0 && webhooks.labels().length === 0);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
