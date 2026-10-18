# Contributing to hackrf-web

Thanks for helping. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first.

This page talks to a device whose firmware we don't control, so most useful
contributions are **evidence from hardware**: a diagnostic sample from a model
or firmware version the page hasn't seen, a quirk written up in `PROTOCOL.md`,
or a fix to the driver with the sample that motivated it.

## Ways to contribute

- **A scan that fails or looks wrong** — use the *Bridge problem* template and
  attach the JSON from *Collect diagnostic sample*. That file is the whole
  point of the diagnostics button; one of them is worth more than a paragraph
  of description.
- **A device the page hasn't been tested with** — same template. If it works,
  say so too: "works on a HackRF with firmware X and hackrf-tools Y" is useful and goes in the README.
- **Bugs in the page itself** — *Bug report* template.
- **Ideas** — *Feature request* template. Views, readouts, export formats,
  levels and markers.
- **Docs** — README, PROTOCOL.md. No hardware needed.
- **Code** — see below.

## The shape of the code

Two programs, one contract (`PROTOCOL.md`). Change the contract first, then
both sides.

- `bridge/src/hackrf_web/` — Python. `server.py` is transport (WebSocket,
  token, HTTP fallback); `session.py` is the state machine and the only place
  that touches `hackrfpy`; `frames.py` is pure (stitching, FFT, binary
  framing); `fake.py` is the simulated board. `hackrfpy` stays unmodified —
  if the bridge needs something the library lacks, open an issue there and
  work around it here until it lands.
- `web/js/device/` — the page's view of the bridge. `bridge-link.js` is
  transport; `hackrf.js` names its methods after hackrfpy's; `demo-link.js`
  replays recorded frames with the same surface.
- `web/js/plot/`, `web/js/ui/`, `web/css/` — the kit shared with nanovna-web
  and tinysa-web. Files listed as *unchanged* in the README's table must stay
  byte-identical with tinysa-web's copies; a fix to one of them goes to all
  three repos in the same change.
- `web/js/main.js` — state and wiring only.

`tests/smoke.py` drives a running `--fake` bridge through every call; run it
before a bridge PR. The page is tested headlessly against the demo and the
fake bridge.

## Style

- Two-space indent; modules export what they need and nothing touches `window`.
- Colours come from the CSS variables at the top. `--trace`, `--maxhold`,
  `--minhold` and `--avg` are the only trace colours (IQ time uses `--trace` for I and `--minhold` for Q); nothing else on the page
  may use them.
- Numbers shown to the user go through `fmtHz` / `toFixed` — no raw floats.
- Copy in sentence case, plain words. The audience is someone with a HackRF on
  the desk, not necessarily someone who has read the firmware.

## Commit and PR conventions

- One logical change per PR; reference the issue it closes.
- Any new device behaviour discovered goes into `PROTOCOL.md` (*Quirks* or
  *Not yet verified*) in the same PR as the code that handles it.
- Add a line to `CHANGELOG.md`.

## License

By contributing, you agree that your contributions are licensed under the
project's **GPL-2.0** license.
