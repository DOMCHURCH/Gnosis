# Voice / UI issues — 2026-08-30

Raised in chat, captured here so nothing gets lost. All items below are now
FIXED unless noted; each says what the actual cause turned out to be, since in
several cases it was not what the symptom suggested.

Regression cover: `verify/s90-voice-overlay.mjs` (new — renders the real overlay
in a browser and measures contrast, geometry and layout), `s97-liquid-glass.mjs`
(rewritten for the new material), `s89-voice-session.mjs`, `s96-view-switcher.mjs`,
`s73-computeruse.mjs`, `s91-firstrun.mjs` (new).

---

## 1. Glassmorphism still isn't reading as real glass

**Status:** FIXED — `electron/voice-overlay.html`

Cause: the blur was 38px. Past roughly 20px a backdrop averages out to its own
mean colour, and the mean of anything is grey — so the panel was a grey blob no
matter how vivid the desktop behind it was, and `saturate()` cannot put back
detail that has already been averaged away. The fill was also 5.5% white (nothing
to catch light) and the shadow was pure black (drains colour from what it
touches).

Now: `blur(16px) saturate(1.8)`, a 10% white fill, a 1px inset white edge, and
the coloured lift shadow `0 8px 32px 0 rgba(31,38,135,0.37)`.

The animated SVG `feTurbulence`/`feDisplacementMap` that had been chained onto
`backdrop-filter` is **removed**. It re-evaluated a turbulence filter over the
whole backdrop every frame on a window that floats permanently above real work,
and the warp was invisible through a 38px blur anyway.

WCAG: solved properly rather than asserted. A translucent panel over an unknown
backdrop cannot pass AA on fill alone, so `backdrop-filter` carries a
`brightness(0.45)` clamp — a white desktop arrives as mid-grey while a colourful
one keeps its hue. Against the worst case (pure-white desktop, bare glass, no
card behind the text) the measured ratios are **7.13:1 / 5.81:1 / 4.78:1** for
`--text` / `--dim` / `--dimmer`. Computed from the rendered layer stack in
`s90-voice-overlay.mjs`, not by eye.

## 2. Shield button collides with the pill's rounded edge

**Status:** FIXED — `electron/voice-overlay.html`

Cause: the pill's right end is a semicircular cap of radius h/2, so 10px of
padding is 10px only at the exact vertical centre and less everywhere else — and
the notification badge overhangs the shield by 2px on two more sides.

Now: the controls sit in a `.pillActions` group with 20px of right padding, and
the buttons are 34px rather than 40px. Measured clearance from the rounded-rect
boundary (sampling each control's rim, not its bounding box) is **29px** for the
shield, **21px** for the ×, **28px** for the badge — and holds at 440 / 380 / 320
/ 260px wide.

## 3. Overlay layout breaks at different aspect ratios / window sizes

**Status:** FIXED — `electron/voice-overlay.html`, `electron/voice.js`

Three separate causes:

- **The canvases had hard-coded `width`/`height` attributes** (440x26 and 520x26)
  while their CSS width was fluid. The backing store is what you draw into; the
  CSS box is what it gets scaled to, so the waveform was drawn at one aspect
  ratio and squashed into another — worse the further the window was from the one
  size the numbers were written for. Now sized from `clientWidth × devicePixelRatio`,
  with the stroke widths and highlight radii scaled to match.
- **`.left { flex: 0 0 300px }`** refused to give up a pixel, so below ~620px the
  tab strip and permission cards were crushed while the conversation column sat
  at full size. Now `flex: 1 1 300px` with a floor, and it stacks below 560px.
- **The window asked for its size regardless of the display.** 720x320 does not
  fit on a small or heavily-scaled screen. `boundsFor()` now caps the request to
  the work area and clamps the position so no part leaves the screen, and the
  overlay re-clamps on `display-metrics-changed` / `display-added` / `display-removed`
  (unplugging a monitor used to strand it on coordinates that no longer existed).

Also fixed while measuring: the tab strip wrapped "Settings" onto a second row,
and the expanded panel's × was pushed off the bottom of a short window.

## 4. Voice-mode permission prompts are too aggressive for MCP / computer-use

**Status:** FIXED — `src/permissions.ts`

The diagnosis in the original note was right: computer-use was
*architecturally* un-silenceable. `dangerous` calls skipped the yolo/approvals
shortcut entirely, and computer-use was unconditionally `dangerous`, so an
"always" could never apply to it — one Allow/Deny card per mouse move.

Now `dangerous` (does this prompt, and is it flagged?) is separated from
`unsilenceable` (may an explicit "always" ever cover it?). Computer use is
dangerous but **silenceable**; genuinely dangerous things — `rm -rf`, writes into
the bare home directory, deletions with no undo, scope confirmations — remain
unsilenceable and prompt every time in every mode.

The approval is keyed on the **server**, not the tool: one "click that for me"
turn fires `mouse_move`, `left_click`, `screenshot` and `type`, and answering
four cards is attrition, not consent.

What an "always" still cannot do, and `s73` pins it: reach `~/.dom` (hard block)
or violate the write scope (hard reject) — in every mode, approved or not.

## 5. Closing the overlay doesn't fully stop voice

**Status:** FIXED — `electron/voice-overlay.html`, `voice-preload.cjs`, `voice.js`

Two bugs, and the first explains why this was confusing: **there was no × in the
overlay markup at all.** Three comments referred to one ("the panel now has a
close button", "the overlay's ×", "press × to end") and the pill rendered only a
shield. The sole exit was Esc, wired to `endSession()`.

And `endSession()` was never a full stop: it hid the panel and disarmed the reply
gate but left the wake-word detector running and the microphone engine open, so
the app kept listening for "hey jarvis" behind a panel the user had dismissed.

Now there are two exits, and they do different things:

- **×** → `voice:stop-voice` → the same teardown as the Settings switch
  (detector stopped, mic released, Kokoro shut down) **and** persists
  `voiceEnabled: false`, so Settings does not go on claiming voice is on.
- **Esc** → ends the conversation, leaves the wake word armed.

Both are labelled in the UI rather than left to be discovered.

## 6. Mobile/tablet UI is stale

**Status:** FIXED — `web/src/SessionsFloor.tsx`, `web/src/clay.css`

Cause was not old CSS winning at small widths, and not a separate stylesheet or
entry point. `clay.css` styles **exclusively by `data-testid`**, and the phone
layout (`< 640px`) is a **separate JSX tree** that carried none of those hooks —
so it silently opted out of the entire redesign while desktop moved on.

Fixes: the mobile tree now emits the shared testids (`page-root`,
`session-title`, `floor-container`; `three-floor` came free from `ThreeFloor.tsx`),
so the radius scale, lift and borders apply. New rules cover the surfaces that
exist only on mobile — the bottom sheets and the tab bar, both floating-tier so
both get the glass treatment — plus two generic `clay-card` / `clay-well` hooks
for nested blocks, so the next sheet does not need a bespoke testid to be styled.
The newcomer-legibility copy is on the phone floor tab now too, and the sidebar
is no longer pinned to 264px inside a full-width tab.

Tablet (640–899px) already went through the desktop return and so already had
clay; it was only losing layout, which is deliberate.

## 7. TERMINAL and SERVE/QR aren't real tabs

**Status:** FIXED — `web/src/app.tsx`

Cause: `<TerminalDock>` was rendered **only inside the floor branch**, while the
TERMINAL chip sat in the always-rendered switcher. On kanban the chip was a live
toggle with nothing behind it — it flipped `terminalOpen` and no dock appeared.

The switcher, the QR popover and the terminal dock are now one `appChrome`
fragment rendered per view branch, so the chip and the thing it opens cannot
drift apart again. A side benefit: the terminal now survives a view change
instead of being unmounted (and its pty dropped) every time the user looks at
the board.

The SERVE dropdown also had no outside-click dismiss — only Escape, re-clicking
the chip, or picking an entry — so a click anywhere else left it sitting over the
page looking stuck. Added.

---

## 8. Fresh installs are missing what this machine accumulated

**Status:** FIXED — `src/firstrun.ts`, `src/mcp/config.ts`, `electron/voicesetup.js`

Raised alongside the list above: a GitHub download does not have the directories,
the MCP connections, or the voice runtime that this development machine has.
Three distinct causes.

**Directories.** `~/Gnosis` and the `~/.dom` subfolders were only ever created as
a side effect — by whichever write needed one first, and for `~/Gnosis` by a
single caller in the desktop shell that fires only when the user has no
configured cwd *and* no default project. `src/firstrun.ts` now creates the whole
tree on every boot (idempotent, never throws, runs *before* the API-key check
because a user with no key yet is exactly a first-launch user), with a short
README in each otherwise-empty folder. Confirmed against the real binary — and it
created a missing `~/Gnosis/workspace` on this machine too.

**MCP.** `defaultMcpConfig()` shipped only context7 / playwright / chrome-devtools.
`computer-use` — the server voice mode's "click for me" actually calls — was
present here only because it had been added to `~/.dom/mcp.json` by hand. Every
fresh install had voice input working and no tool behind the computer-use half.
Now in the default registry.

**Kokoro / openWakeWord.** These are Python packages plus ~350MB of model weights;
the installer ships `dist/` and `electron/` and cannot bundle them. The app could
only ever *report* that they were missing and print a pip command. There is now
an **Install voice support** button in Settings (`electron/voicesetup.js`) that
installs the packages, downloads the wake-word models and fetches the Kokoro
weights, streaming progress (a silent five-minute 325MB download is
indistinguishable from a hang).

It deliberately does not install Python — it says so and links the download. It
picks the interpreter that already has the packages, else the newest within the
onnxruntime wheel ceiling (3.13): on this machine that correctly resolves to the
Python 3.12 that has them, rather than the 3.14 launcher default where the
install would have failed with a confusing "no matching distribution". `--user`
is omitted inside a virtualenv, where it is a hard error.

---

**File location:** `C:\Users\Dominique\dom\VOICE-UI-ISSUES.md`
