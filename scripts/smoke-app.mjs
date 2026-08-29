// Smoke test for the DESKTOP APP, driven through the real Electron binary.
//
// The verify/ suites are offline and mock the provider, which is right for them
// but means none of them can answer "does the installed app actually work". This
// launches electron/main.js for real — real boot, real engine, real served UI in
// a real BrowserWindow — and runs slash commands through the window's own input.
//
// It needs an OpenRouter key (boot fails without one) and takes ~40s, which is
// why it lives here rather than in the verify harness:
//
//   node scripts/smoke-app.mjs [screenshot.png]
//
// The commands it runs are the ones that answered "attach a terminal for the full
// command set" before app/terminal parity was fixed. If that refusal ever comes
// back, this is what catches it.
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const app = await electron.launch({ args: [path.join(root, "electron", "main.js")], env: { ...process.env, GNOSIS_SKIP_MCP: "1", GNOSIS_CWD: root } });
const win = await app.firstWindow();
for (let i = 0; i < 60 && !win.url().startsWith("http"); i++) await win.waitForTimeout(1000);
await win.waitForSelector('[data-testid="left-panel"]', { timeout: 60000 });

const input = win.locator('input[placeholder*="message this session"], textarea[placeholder*="message this session"]').first();
async function run(cmd) {
  await input.click();
  await input.press("Control+a");
  // Type it for real: fill() sets the DOM value without the keystrokes React
  // listens to, so the component never learns there is anything to send.
  await input.pressSequentially(cmd, { delay: 25 });
  await win.waitForTimeout(400);
  // "/" opens the command autocomplete, and the first Enter COMPLETES from that
  // list rather than submitting (SessionsFloor.tsx onKeyDown). That is how a
  // person uses it too: Enter to accept the completion, Enter to send.
  await input.press("Enter");
  await win.waitForTimeout(250);
  await input.press("Enter");
  await win.waitForTimeout(3000);
  return await win.evaluate(() => document.body.innerText);
}

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const OLD = /attach a terminal for the full command set/;

for (const [cmd, expect] of [["/tools", /bash/], ["/skills", /skills|no skills loaded/i], ["/workspace", /workspace roots/i], ["/context", /context: \d+ tokens/]]) {
  const text = await run(cmd);
  ok(`${cmd} answers in the app`, expect.test(text));
  ok(`${cmd} is not refused`, !OLD.test(text));
}
if (process.argv[2]) await win.screenshot({ path: process.argv[2] });
await app.close();
console.log(fails ? `${fails} FAILED` : "app command parity confirmed");
process.exit(fails ? 1 : 0);
