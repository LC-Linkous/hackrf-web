"""`hackrf-web` command line."""
# SPDX-License-Identifier: GPL-2.0-only
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import webbrowser

from . import __version__

PAGES_URL = "https://lc-linkous.github.io/hackrf-web/"


def build_device(args: argparse.Namespace):  # type: ignore[no-untyped-def]
    if args.fake:
        from .fake import FakeHackRF
        return FakeHackRF()
    try:
        from hackrfpy import HackRF  # type: ignore
    except ImportError:
        sys.exit("hackrfpy is not installed: pip install hackrfpy  (or run with --fake)")
    dev = HackRF(tools_dir=args.tools_dir, verbose=args.verbose)
    return dev


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="hackrf-web", description="Local bridge between the hackrf-web page and a HackRF One (through hackrfpy).")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token", help="use this token instead of a random one (for scripts)")
    ap.add_argument("--allow-tx", action="store_true", help="enable tx.* calls (still needs confirm + duration per call)")
    ap.add_argument("--tx-max-seconds", type=float, default=30.0)
    ap.add_argument("--record-dir", default=os.path.join(os.path.expanduser("~"), "hackrf-web-recordings"))
    ap.add_argument("--tools-dir", help="folder holding hackrf_info / hackrf_transfer / hackrf_sweep")
    ap.add_argument("--fake", action="store_true", help="simulated HackRF (no board, no hackrf-tools)")
    ap.add_argument("--fps", type=float, default=12.0, help="max spectrum frames per second sent to the page")
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    ap.add_argument("--local-page", action="store_true", help="open the bundled page from the bridge instead of GitHub Pages")
    ap.add_argument("--doctor", action="store_true", help="print hackrfpy's preflight report and exit")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--version", action="version", version=__version__)
    args = ap.parse_args(argv)

    os.makedirs(args.record_dir, exist_ok=True)
    dev = build_device(args)
    if args.doctor:
        print(json.dumps(dev.preflight(args.record_dir), indent=2, default=str))
        return

    from .server import Bridge, WEB_DIR
    b = Bridge(dev, port=args.port, token=args.token, allow_tx=args.allow_tx, tx_max_seconds=args.tx_max_seconds,
               record_dir=args.record_dir, fake=args.fake, fps=args.fps)
    url = b.page_url(None if args.local_page else PAGES_URL)
    print(f"hackrf-web bridge {__version__}  ws://127.0.0.1:{args.port}/  token {b.token}")
    print(f"  device: {'simulated (--fake)' if args.fake else 'hackrfpy → hackrf-tools'}   transmit: {'ENABLED (--allow-tx)' if args.allow_tx else 'disabled'}   recordings: {os.path.abspath(args.record_dir)}")
    print(f"  page:   {url}")
    if not os.path.isdir(WEB_DIR):
        print("  (the page is not bundled with this build; the GitHub Pages URL above is the one to use)")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        asyncio.run(b.run())
    except KeyboardInterrupt:
        pass
    finally:
        if b.sm is not None:
            try:
                b.sm.kill()
            except Exception:
                pass


if __name__ == "__main__":
    main()
