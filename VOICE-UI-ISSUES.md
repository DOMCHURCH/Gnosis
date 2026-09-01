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

---

# Overlay audit — 2026-09-01

A second pass over the same panel. Several of the fixes above turned out to be
right about the symptom and wrong about the cause, which is recorded here
because the wrong causes were plausible and will look plausible again.

## 9. The black rectangle was `backdrop-filter`, not a clipped shadow

**Status:** FIXED — `electron/voice-overlay.html`, `electron/voice.js`

It was diagnosed first as the drop shadow being clipped at the window edge, and
"fixed" by giving the window 24px of transparent margin on every side. The box
got BIGGER, by exactly the amount the window grew — which a clipped shadow
cannot do, and which is what finally identified the real cause.

An element with `backdrop-filter` needs a backdrop to sample. In a transparent
window there is none: the desktop belongs to the compositor, not the page. So
Chromium gives the window an opaque backing to filter instead, and every region
the page has not painted over comes out black.

It could not have worked anyway — it can only blur content inside the same
window, and there is nothing behind the glass. Removed. `mix-blend-mode: screen`
went with it for the same reason: a blend mode is also a compositing operation
against the backdrop.

What replaces it is layered translucency, and it is **not** blur and is not
described as blur anywhere in the file: a tinted scrim over a charcoal-navy
base, an environmental cyan/violet cast, an internal sheen, a rim that is bright
along the top and fades down the sides, an inner rim, and a coloured shadow that
fits inside the margin.

`brightness(0.45)` was doing one real job — clamping the backdrop so text stayed
legible — so the scrim absorbed it at 0.78. Measured from real pixels in a real
transparent window, over four backdrops: **6.70 / 15.47 / 11.10 / 9.24 to one**
against 4.5 for AA.

The shadow margin stayed. It is genuinely needed, and s110 now asserts the
corners of the window capture at **alpha 0**.

## 10. "Answering…" lit the READY step

**Status:** FIXED — `electron/voice-overlay.html`

`STEP` mapped `speaking → stepReady`, so the panel said ANSWERING and READY at
once. There is no ready state to light: `voice.js` emits exactly `listening`,
`thinking`, `speaking` and `error`. The rail is those three plus an error that
lights nothing, and every surface — both labels, the rail, the orb, the aria
label — is now set by one `applyState()` rather than four assignments in a row.

## 11. The × turned voice off

**Status:** FIXED — reverses #5 above

#5 made × a full stop, reasoning that closing the thing that represents a
feature should disable the feature. That is not what × means anywhere else, and
it left no way to dismiss the panel without disarming the wake word and going to
Settings to get it back. Now: **Esc and × end the conversation**, and a separate
crossed-microphone button releases the microphone and persists
`voiceEnabled: false`. Two actions that differ that much in how hard they are to
undo should not share a button.

## 12. The collapsed hint was ellipsised

**Status:** FIXED

Three clauses in an element with `text-overflow: ellipsis`, so what reached the
screen was `… × turns voice off · 6…` — including the countdown, the one part
that changes every second. The hint is two clauses, the countdown is its own
chip, and at narrow widths they drop out in priority order rather than
truncating: hint first, then the countdown, then the voice-off button, and the
state label never. s110 asserts nothing displayed is ever clipped.

## 13. Memory / Tools / Settings were placeholders

**Status:** FIXED

Three tabs whose entire content was a sentence saying the tab was a placeholder.
Disabled, dimmed, and given tooltips naming where the real thing lives.

## 14. The footer over-promised

**Status:** FIXED

"Gnosis will always ask before taking actions that affect your system" is not
true: `PermissionAnswer` includes `"always"` and the caller persists it, and
yolo mode auto-approves. It now says what is actually guaranteed — including
that deleting outside the workspace always asks, which `permissions.ts` really
does enforce even in yolo.

## 15. The geometry tests measured the viewport as the pill

**Status:** FIXED — `verify/s90-voice-overlay.mjs`

`body` carries 24px of transparent padding, so the viewport is 48px larger than
the pill in both axes. Treating it as the pill put the rounded boundary 24px
outside where it is and over-reported every control's clearance. Measured from
`.frame`'s own `getBoundingClientRect()` now.

The contrast block was worse: it parsed the first `rgba()` out of `.glass` and
composited by hand, so the moment the material became five layers it measured
the violet tint at 0.075 and reported **1.13:1** for text that was perfectly
readable. Deleted, and replaced by real pixels in `s110-voice-overlay-render.mjs`.

**Not verified locally:** the black box was only ever reproduced on this
machine's display at 250% scaling, and the alpha assertions run against
`capturePage()` rather than the desktop composite — `desktopCapturer` returned
empty thumbnails here and PowerShell's `CopyFromScreen` has no desktop handle
from a non-interactive session. Acrylic/Mica was NOT adopted: it requires an
opaque window on Windows 11, which is the thing this panel must not be.
