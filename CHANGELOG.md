# Changelog

## v0.1.0 — first release

- Bridge (`pip install hackrf-web`): loopback WebSocket server in front of
  unmodified hackrfpy; per-launch token; `--fake` simulated board;
  `--doctor`; serves the page itself as a fallback to GitHub Pages.
- Session manager with idle / sweep / iq / tx states, one child process at a
  time, every transition through idle. Sweep rows stitched into frames; IQ
  blocks windowed, FFT'd and averaged in the bridge; frames at ≤ 12/s.
- IQ recording to interleaved int8 + SigMF sidecar through hackrfpy, with a
  mandatory time cap and a disk check; display blocks may drop, recorded
  bytes never do.
- Transmit (`tx.tone`) behind three gates: `--allow-tx`, `confirm: true`,
  a capped duration. The page shows the section locked with the reason.
- Page: Bridge / Sweep / IQ / Gains / Recording / Export / Transmit /
  Diagnostics / Settings / About; windows with Spectrum, Waterfall, IQ time
  and Constellation; markers with interpolated peaks, −3 dB bandwidth, band
  power, and "tune IQ to marker"; page-side max/min/average/hold.
- Demo replays spectrum frames computed from a real HackRF One recording
  (hackrfpy's `fm_98.1MHz_8Msps.iq`) and sweep frames from the fake device.
- CI: smoke test of the bridge on Linux and Windows; wheel built on push and
  attached to releases.
