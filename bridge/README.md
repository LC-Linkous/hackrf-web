# hackrf-web bridge

The local half of [hackrf-web](https://github.com/LC-Linkous/hackrf-web). It
runs on the computer the HackRF One is plugged into, drives the board through
[hackrfpy](https://github.com/LC-Linkous/hackRF_python) (which runs the
`hackrf-tools` binaries), and serves spectrum frames to the browser page over
a loopback WebSocket.

```sh
pip install hackrf-web
hackrf-web            # starts the bridge and opens the page with the token
hackrf-web --fake     # no board needed: simulated HackRF, same code path
hackrf-web --allow-tx # enables tx.* calls (see PROTOCOL.md for the gates)
```

Requires Python 3.11+ and the `hackrf-tools` binaries on the PATH (or
`--tools-dir`). `hackrf-web --doctor` prints hackrfpy's preflight report and
exits.

Protocol: [PROTOCOL.md](https://github.com/LC-Linkous/hackrf-web/blob/main/PROTOCOL.md).
License: GPL-2.0.
