// Verify (QR codes): the terminal QR (qrcode-terminal) renders a non-empty
// multi-line block for the tokenized URL, and the web QR lib (qrcode) produces an
// inline SVG — no external image request.
import { qrTerminal } from "../dist/qr.js";
import QRCode from "qrcode";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const url = "http://127.0.0.1:7777/?token=abc123DEF456";

// Terminal QR (used by dom serve / /serve).
const term = await qrTerminal(url);
ok("terminal QR is non-empty", term.length > 0);
ok("terminal QR spans multiple rows", term.split("\n").length >= 5);
ok("terminal QR uses block glyphs", /[█▀▄]/.test(term));

// Web QR (used by the QR popover) — inline SVG, no <img>/external URL.
const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#0D0D12", light: "#C9C9D6" } });
ok("web QR is an inline <svg>", svg.trimStart().startsWith("<svg") && svg.includes("</svg>"));
ok("web QR references no external image (no <image>/href to a URL)", !/<image\b/i.test(svg) && !/href\s*=\s*["']https?:/i.test(svg));
ok("web QR carries the palette colors", svg.includes("#0D0D12") && svg.includes("#C9C9D6"));

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
