# The bridge protocol

hackrf-web is two programs: a static page (this repo's `web/`, served from
GitHub Pages or by the bridge itself) and the **bridge**, a small Python
process on the computer the HackRF is plugged into. The bridge is the only
thing that touches the device, and it does so through
[hackrfpy](https://github.com/LC-Linkous/hackRF_python), which in turn runs
the `hackrf-tools` binaries as child processes. The page never sees a binary,
an argv, or a raw sample stream it did not ask for.

This document is the contract between the two. The Python (`bridge/`) and
JavaScript (`web/js/device/`) sides are both written to it.

```
  page ──── WebSocket ws://127.0.0.1:8765/?token=… ────► bridge ──► hackrfpy ──► hackrf_sweep
       ◄─── JSON replies, JSON events, binary frames ────        ──► hackrf_transfer
```

## Transport

- WebSocket, loopback only. The bridge binds `127.0.0.1` and never another
  address. The port defaults to 8765 (`--port`).
- A **token** is generated per launch and printed. The page sends it as the
  `token` query parameter on the WebSocket URL; any other token is closed
  with code 4401 before the first message. The bridge opens the page with the
  token in the URL fragment (`#bridge=127.0.0.1:8765&token=…`); fragments are
  never sent to any server.
- The bridge answers an HTTP `GET /` on the same port with the page (option
  B in the README) and `GET /healthz` with `{ "tool": "hackrf-web", "version": … }`.
  It answers CORS preflights with `Access-Control-Allow-Private-Network: true`
  so a page on an https origin may reach loopback under Chrome's private
  network access rules.

## Messages

Text frames are JSON. There are three shapes:

```jsonc
// call (page → bridge)
{ "id": 7, "method": "session.start", "params": { … } }
// reply (bridge → page)
{ "id": 7, "result": { … } }
{ "id": 7, "error": { "code": "device_busy", "message": "…", "detail": { … } } }
// event (bridge → page, unsolicited)
{ "event": "session", "data": { "state": "sweep", … } }
```

`id` is any JSON value the page chooses; it is echoed back unchanged. Calls
are answered in order per connection, but a long call (a `tx.tone` with a
duration, say) does not block events.

Error codes: `bad_request`, `not_allowed` (TX without `--allow-tx`, a call
that needs `confirm: true`), `busy` (a session is running and this call needs
idle), `device_busy` (another program holds the HackRF), `device_missing`,
`device_unresponsive`, `environment` (tools missing, disk full), `internal`.

### Binary frames

Spectrum frames and IQ snapshots are binary so the page can hand them to a
typed array without parsing. Layout: a 4-byte little-endian `uint32` header
length, that many bytes of UTF-8 JSON header, then the payload.

```
spectrum  header { "kind": "spectrum", "seq": 120, "t": 1760731200.123,
                   "start": 88000000, "stop": 108000000, "points": 1024,
                   "bin_width": 19531.25, "level_unit": "dBFS",
                   "mode": "iq", "settings": { … }, "dropped": 0 }
          payload Float32Array[points]       level per bin, ascending frequency
iq        header { "kind": "iq", "seq": 3, "t": …, "center": 98100000,
                   "sample_rate": 8000000, "count": 16384, "settings": { … } }
          payload Int8Array[2*count]         interleaved I,Q as the HackRF sends them
```

`level_unit` is `dBFS` unless a calibration is loaded (not in v0.1); it is
never silently `dBm`. In sweep mode the values are what `hackrf_sweep`
prints, which are relative and depend on the gains; the unit string is still
`dBFS` and the header carries the gains that produced them.

## Calls

### device

| Method | Params | Result |
|---|---|---|
| `device.preflight` | — | hackrfpy's `preflight()` report: `tools`, `boards`, `tool_version`, `features`, `disk_free_bytes`, `problems[]`, plus `bridge` `{version, allow_tx, fake}` |
| `device.detect` | — | hackrfpy's `detect()`: `found`, `ready`, `count`, `boards[]`, `problem` |
| `device.info` | — | raw `hackrf_info` text |

`device.*` runs only in the `idle` state; `hackrf_info` needs the device.

### session

One session at a time. Every transition passes through `idle`; changing a
setting while running is `session.stop` then `session.start`.

| Method | Params | Notes |
|---|---|---|
| `session.start` | `mode: "sweep"`, `f_min`, `f_max` (Hz), `bin_width` (Hz, optional), `lna`, `vga`, `amp` | `hackrf_sweep`. Edges snap outward to whole MHz; the reply carries the snapped values and the gains as hackrfpy snapped them |
| `session.start` | `mode: "iq"`, `center`, `sample_rate` (Hz), `fft_size` (256–8192), `lna`, `vga`, `amp`, `avg` (1–16) | `hackrf_transfer -r -`. The bridge decodes, windows (Hann), FFTs, averages and emits a spectrum frame at most `fps` times a second (default 12). Display blocks may be dropped; recorded bytes never are |
| `session.stop` | — | Clean interrupt through hackrfpy, the same path the library uses so a recording is not cut mid-sample |
| `session.kill` | — | Terminate the child when stop did not work |
| `session.status` | — | `{ state, mode, settings, seq, fps, dropped, since }` |
| `session.tune` | `offset` (Hz) | IQ mode: digital shift inside the captured band, no restart (v0.2) |

State machine, from the build plan:

| State | Child | Entered by |
|---|---|---|
| `idle` | none | start-up, `session.stop`, any failure |
| `sweep` | `hackrf_sweep` | `session.start` with `mode: sweep` |
| `iq` | `hackrf_transfer -r` | `session.start` with `mode: iq` |
| `tx` | `hackrf_transfer -t` / `-c` | `tx.tone` from `idle` only |

### iq

| Method | Params | Result |
|---|---|---|
| `iq.snapshot` | `count` (samples, ≤ 65536) | a binary `iq` frame with the most recent block, from the live IQ session |

### record

| Method | Params | Notes |
|---|---|---|
| `record.start` | `max_seconds` (required) | IQ mode only in v0.1. Writes interleaved int8 to `<dir>/hackrf-<stamp>.iq` with a SigMF sidecar through hackrfpy's `write_sigmf_meta`. Refused if `estimate_capture` says the disk cannot hold it |
| `record.stop` | — | Closes the file; result has `path`, `bytes`, `seconds` |
| `record.status` | — | `{ active, path, bytes, seconds, free_bytes }` |

The recorder sits on the same decoded blocks the FFT uses and re-encodes
them to int8 (`round(x * 128)` — exact, since hackrfpy normalises by 128). A
`session.stop` while recording closes the file first.

### tx

Transmit is behind three gates, all three required: the bridge must have
been started with `--allow-tx`; the call must carry `confirm: true`; and a
duration is mandatory. The page shows the Transmit section greyed with the
reason when the bridge was started without `--allow-tx`.

| Method | Params | Notes |
|---|---|---|
| `tx.tone` | `freq`, `sample_rate`, `txvga` (0–47), `amp`, `amplitude` (0–127), `duration` (s, required, ≤ `--tx-max-seconds`, default 30), `confirm: true` | hackrfpy `transmit_cw`. From `idle` only; the bridge sets the library to TX mode, transmits, and returns it to RX mode afterwards, whatever happened |
| `tx.stop` | — | Stops early |

`tx.file` is reserved for a later release. Firmware writes (`spiflash_write`,
`cpldjtag`) are not reachable through any call.

## Events

| Event | Data | When |
|---|---|---|
| `hello` | `{ version, allow_tx, fake, tx_max_seconds, page_version_expected }` | first message after the token is accepted |
| `session` | `{ state, mode, settings, reason? }` | every state change |
| `record` | `{ active, path, bytes, seconds }` | start, stop, and every ~1 s while recording |
| `device` | `{ status: "lost" \| "unresponsive" \| "busy", stderr? }` | the child exited or went silent |
| `log` | `{ level, text }` | one line the page shows in its console: the argv the bridge ran, hackrfpy warnings (gain snaps, MHz snapping), child stderr |
| `tx` | `{ on, freq, seconds_left }` | every second while transmitting |

## The fake device

`hackrf-web --fake` runs the whole bridge against a simulated HackRF: sweep
rows and IQ blocks are synthesised (FM carriers at 98.1 and 103.7 MHz with
the right deviation, a 433.92 MHz keyed transmitter, noise at the right
level for 8-bit samples), every state transition is real, and recordings are
real files. It exists so the page can be tested end to end on a machine
without a board, and so the demo data shipped with the page comes from the
same code path.

## Versions

The page and the bridge each carry a version. `hello` reports the bridge's;
the page compares major.minor and shows a notice if they differ. Pages
updates on every push; the bridge updates on `pip install -U hackrf-web`.
