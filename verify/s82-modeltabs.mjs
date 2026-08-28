// Verify (model picker tabs): the catalog splits into ALL / FREE / PAID, the paid
// side ranks cheapest-first off the same price string the user is reading, and the
// tabs never appear on a picker that has no tiers.
import { TABS, promptPrice, tierCounts, isTabbed, visibleItems } from "../web/src/modeltabs.js";
import { buildModelPickItems } from "../dist/models.js";

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const entry = (id, prompt, completion, known = true) => ({
  id, name: id, context_length: 200000, pricingKnown: known,
  pricing: { prompt, completion, cacheRead: 0, cacheWrite: 0 },
  supported_parameters: ["tools"], input_modalities: ["text"],
});

// A catalog shaped like the real one: free variants, a cheap model, a dear one,
// and a Groq model whose provider publishes no prices at all.
const items = buildModelPickItems([
  entry("anthropic/claude-opus", 0.000005, 0.000025),
  entry("google/gemini-flash-lite", 0.0000001, 0.0000004),
  entry("minimax/minimax-m3:free", 0, 0),
  entry("openai/gpt-4o-mini", 0.00000015, 0.0000006),
  entry("cohere/north:free", 0, 0),
  entry("groq/llama-3.3-70b", 0, 0, false),
]);

// --- tabs appear only where there is something to split ----------------------
ok("three tabs", TABS.map((t) => t.key).join(",") === "all,free,paid");
ok("the model picker is tabbed", isTabbed("model", items));
ok("the session picker is NOT", !isTabbed("session", [{ value: "s1", label: "s1", hint: "3 msgs" }]));
ok("a model list with no tiers is NOT", !isTabbed("model", [{ value: "m", label: "m" }]));

// --- counts -------------------------------------------------------------------
const c = tierCounts(items);
ok("ALL counts everything", c.all === 6);
ok("FREE counts the free variants", c.free === 2);
ok("PAID counts the priced ones", c.paid === 3);
ok("an unpriced model is in neither FREE nor PAID", c.free + c.paid === 5);

// --- price read back out of the hint the user is looking at -------------------
ok("a price hint parses", promptPrice("$3.00/$15.00 per 1M in/out · 200K ctx") === 3);
ok("a sub-dollar price parses", promptPrice("$0.1/$0.4 per 1M in/out") === 0.1);
ok("free has no price", promptPrice("free · 256K ctx") === 0);
ok("an unpriced model has no price", promptPrice("price n/a") === 0);
ok("a missing hint does not throw", promptPrice(undefined) === 0);

// --- ordering -----------------------------------------------------------------
const paid = visibleItems(items, "paid", "");
ok("PAID holds only paid models", paid.every((i) => i.tier === "paid"));
ok("PAID is cheapest first",
  paid.map((i) => i.value).join(",") === "google/gemini-flash-lite,openai/gpt-4o-mini,anthropic/claude-opus");
ok("...which really is ascending", paid.map((i) => promptPrice(i.hint)).every((v, i, a) => i === 0 || a[i - 1] <= v));

const free = visibleItems(items, "free", "");
ok("FREE holds only free models", free.length === 2 && free.every((i) => i.tier === "free"));

const all = visibleItems(items, "all", "");
ok("ALL holds everything", all.length === 6);
ok("ALL leads with the free models", all.slice(0, 2).every((i) => i.tier === "free"));
ok("...then runs cheapest to dearest",
  all.slice(2).map((i) => promptPrice(i.hint)).every((v, i, a) => i === 0 || a[i - 1] <= v));
ok("...ending on the most expensive", all[all.length - 1].value === "anthropic/claude-opus");

// --- filter and tab compose ---------------------------------------------------
ok("filtering inside a tab keeps the tab", visibleItems(items, "paid", "gemini").every((i) => i.tier === "paid"));
ok("a filter that matches only free rows is empty under PAID", visibleItems(items, "paid", "minimax").length === 0);
ok("...and finds it under FREE", visibleItems(items, "free", "minimax").length === 1);
ok("the filter still reads the hint", visibleItems(items, "all", "200K").length === 6);
ok("an untabbed list ignores the tab entirely", visibleItems(items, "free", "", false).length === 6);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
