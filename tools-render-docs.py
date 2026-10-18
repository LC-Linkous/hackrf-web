#!/usr/bin/env python3
"""Render the repo's Markdown (README, PROTOCOL, CHANGELOG, CONTRIBUTING) as
pages under the site, in the app's own theme, so the live site carries its
documentation. Run by the pages workflow; harmless to run locally.

    python tools-render-docs.py _site        # writes _site/readme/index.html etc.
"""
# SPDX-License-Identifier: GPL-2.0-only
import html
import pathlib
import re
import sys

import markdown

ROOT = pathlib.Path(__file__).parent
DOCS = [("readme", "README.md", "README"), ("protocol", "PROTOCOL.md", "Bridge protocol"),
        ("changelog", "CHANGELOG.md", "Changelog"), ("contributing", "CONTRIBUTING.md", "Contributing")]

TEMPLATE = """<!DOCTYPE html>
<html lang="en" data-theme="dark" data-traces="instrument">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · hackrf-web</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/theme.css"><link rel="stylesheet" href="../css/doc.css">
</head>
<body>
<header class="topbar"><h1><a href="../">hackrf-web</a></h1><nav>{nav}<a href="https://github.com/LC-Linkous/hackrf-web">Source</a><a href="https://lc-linkous.github.io/">Portfolio</a></nav></header>
<main class="doc">{body}</main>
<footer>Rendered from <code>{src}</code> at commit time · <a href="../">open the tool</a> · GPL-2.0 · Maintained by <a href="https://github.com/LC-Linkous">LC Linkous</a>.</footer>
<script>try{{const t=JSON.parse(localStorage.getItem('hackrf-web.settings')||'{{}}').theme;if(t)document.documentElement.setAttribute('data-theme',t);}}catch(e){{}}</script>
</body></html>
"""


def render(src: pathlib.Path) -> str:
    text = src.read_text(encoding="utf-8")
    # links to sibling .md files → the rendered pages; the live-tool link stays as is
    for slug, name, _ in DOCS:
        text = re.sub(rf"\]\((?:\./)?{re.escape(name)}\)", f"](../{slug}/)", text)
    text = text.replace("](web/media/", "](../media/").replace('src="web/media/', 'src="../media/').replace("](LICENSE)", "](https://github.com/LC-Linkous/hackrf-web/blob/main/LICENSE)")
    return markdown.markdown(text, extensions=["fenced_code", "tables", "toc"])


def main(out: str) -> None:
    site = pathlib.Path(out)
    nav = "".join(f'<a href="../{slug}/">{label}</a>' for slug, _, label in DOCS)
    for slug, name, label in DOCS:
        src = ROOT / name
        if not src.exists():
            continue
        body = render(src)
        d = site / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(TEMPLATE.format(title=html.escape(label), nav=nav.replace(f'href="../{slug}/"', f'href="../{slug}/" aria-current="page"'), body=body, src=name), encoding="utf-8")
        print("rendered", name, "→", d / "index.html")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "_site")
