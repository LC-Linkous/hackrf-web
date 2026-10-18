#!/usr/bin/env python3
"""Copy web/ into the bridge package so `hackrf-web --local-page` can serve it.
Run before `python -m build` in bridge/. The copy is git-ignored."""
import shutil, pathlib
root = pathlib.Path(__file__).parent
dst = root / "bridge" / "src" / "hackrf_web" / "web"
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(root / "web", dst, ignore=shutil.ignore_patterns("*.png"))
print("copied web/ →", dst)
