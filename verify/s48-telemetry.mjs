// Verify (agent telemetry): the pure telemetry accumulator folds tool.end /
// turn.start / turn.end into per-agent stats — tool counts by name, success rate,
// cumulative + per-turn tokens, cached tokens, and a live elapsed clock — and the
// sparkline renders a series as unicode bars.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const t = await import(pathToFileURL(path.resolve(here, "../web/src/telemetry.js")).href);

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// Fold a sequence of events for one tab, injecting a fixed clock.
let rec = t.emptyTelemetry();
const at = (ev, now = 0) => { rec = t.foldTelemetry(rec, ev, now); };

ok("empty telemetry has zeroed fields", rec.turns === 0 && rec.tokens === 0 && rec.ok === 0 && rec.tools && Object.keys(rec.tools).length === 0);

at({ type: "turn.start", tabId: 1 }, 1000);
ok("turn.start records the start time", rec.turnStart === 1000);

at({ type: "tool.end", tabId: 1, tool: "read", ok: true });
at({ type: "tool.end", tabId: 1, tool: "read", ok: true });
at({ type: "tool.end", tabId: 1, tool: "edit", ok: true });
at({ type: "tool.end", tabId: 1, tool: "bash", ok: false });

const stats = t.toolStats(rec);
ok("tool totals count every tool.end", stats.total === 4);
ok("success rate reflects ok/fail (3/4 = 0.75)", Math.abs(stats.successRate - 0.75) < 1e-9);
ok("ok and fail are tracked separately", stats.ok === 3 && stats.fail === 1);

const list = t.toolList(rec);
ok("tool list is sorted busiest-first (read ×2 leads)", list[0].name === "read" && list[0].count === 2);
ok("a failing tool records its fail count", list.find((x) => x.name === "bash").fail === 1);

at({ type: "turn.end", tabId: 1, cost: 0.01, tokens: 500, cachedTokens: 100 }, 5000);
ok("turn.end increments the turn counter", rec.turns === 1);
ok("turn.end accumulates total tokens", rec.tokens === 500);
ok("turn.end accumulates cached tokens", rec.cachedTokens === 100);
ok("turn.end clears the elapsed clock", rec.turnStart === null);
ok("per-turn tokens are pushed to the series", rec.tokensSeries.length === 1 && rec.tokensSeries[0] === 500);

at({ type: "turn.start", tabId: 1 }, 9000);
at({ type: "turn.end", tabId: 1, cost: 0.02, tokens: 1500, cachedTokens: 0 }, 12000);
ok("a second turn extends the series", rec.tokensSeries.length === 2 && rec.tokensSeries[1] === 1500);
ok("cumulative tokens sum across turns", rec.tokens === 2000);

// elapsed clock
ok("elapsedLabel is empty when idle", t.elapsedLabel(null, 10000) === "");
at({ type: "turn.start", tabId: 1 }, 20000);
ok("elapsedLabel shows seconds mid-turn", t.elapsedLabel(rec.turnStart, 24000) === "4s");
ok("elapsedLabel rolls into minutes", t.elapsedLabel(rec.turnStart, 20000 + 75000) === "1m 15s");

// sparkline
ok("sparkline is empty for an empty series", t.sparkline([]) === "");
const sp = t.sparkline([0, 5, 10]);
ok("sparkline maps min→low bar and max→full block", sp.length === 3 && sp[0] === "▁" && sp[2] === "█");

// series is capped at 40 entries (oldest dropped)
let capped = t.emptyTelemetry();
for (let i = 0; i < 50; i++) capped = t.foldTelemetry(capped, { type: "turn.end", tabId: 1, tokens: i, cachedTokens: 0 }, 0);
ok("the per-turn series is capped at 40 (oldest pruned)", capped.tokensSeries.length === 40 && capped.tokensSeries[0] === 10);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
