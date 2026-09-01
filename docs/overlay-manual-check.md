# Voice overlay — the one-minute manual check

## What this is for

Everything else about the overlay is measured automatically. `verify/s110`
opens a real transparent Electron `BrowserWindow` — the same options
`voice.js` uses — and reads the alpha channel back with `capturePage()`. That
catches the `backdrop-filter` class of bug, which is what was painting a black
rectangle around the pill.

**It cannot catch the last step.** `capturePage()` reads the *window's own
buffer*, not the screen. Whether the Windows desktop compositor then blends that
buffer onto what is behind it — at this machine's real display scaling, on this
GPU, with this driver — is a question only a person looking at a screen can
answer. No test in this repo claims to have answered it.

This checklist is that answer. It takes about a minute.

## Run it

**Against the packaged app** (this is the one that settles it):

```cmd
set GNOSIS_OVERLAY_DIAGNOSTIC=1
"%LOCALAPPDATA%\Programs\Gnosis\Gnosis.exe"
```

**Against the source tree** (faster loop while iterating):

```
npm run overlay:check
```

Either way you get the real overlay window on top of a set of test backdrops,
and nothing else — no engine, no server, no tray, no session.

## Keys

| Key | What it does |
| --- | --- |
| `Space` | collapsed ⇄ expanded |
| `1` `2` `3` `4` | listening / processing / answering / error |
| `B` | cycle the backdrop: white → black → colour → detail → bare desktop |
| `M` | move it to the next display |
| `Q` / `Esc` | quit |

## The checks

Press `B` between each one so you see it over every backdrop.

- [ ] **1. No black rectangle.** Outside the rounded panel you see the backdrop,
      not a dark box. This is the bug; everything else is secondary.
- [ ] **2. The shadow fades.** The soft halo around the panel dissolves into the
      backdrop. It does not stop at a straight edge.
- [ ] **3. No flash on resize.** Press `Space` several times. Nothing goes black
      between the two sizes.
- [ ] **4. No black box on the other monitor.** Press `M`. Still clean.
- [ ] **5. Transparent over the bare desktop.** Press `B` until the backdrop is
      "none". The corners show your wallpaper.
- [ ] **6. Controls work.** Click the shield — the panel expands to Permissions.
      Click the × — it closes the conversation. Neither one should also do the
      other's job.
- [ ] **7. Readable everywhere.** The state label is legible over the white
      backdrop and over the busy checkered one.

A "no" on 1–5 is the regression this mode exists to find. Note which number and
which backdrop.

## Also worth doing once, in the real app

The diagnostic runs the overlay standalone. To check it over the app itself:

1. Launch Gnosis normally, say "hey jarvis", and let the pill appear.
2. Drag it over the Gnosis main window. Still no black box?
3. Click somewhere in the Gnosis window *through* the transparent margin around
   the pill — the click should reach the window underneath, not the overlay.

## What the automated suites do cover

So it is clear where the line is:

| Suite | Covers |
| --- | --- |
| `s110-voice-overlay-render` | Real transparent window: per-pixel alpha at every corner and edge, WCAG contrast measured from composited pixels over four backdrops, the status rail's geometry, every control's actual behaviour, 24 review screenshots |
| `s111-overlay-packaged` | The packaged `app.asar` contains this overlay, byte-identical, with no `backdrop-filter` or `mix-blend-mode` |
| `s97-liquid-glass` | The material: no compositor effects, every shadow stop fits inside the transparent margin |
| `s90-voice-overlay` | Drag regions, hit-testing, the shadow padding agreeing between JS and CSS |

None of them look at a monitor. That is what this file is for.
