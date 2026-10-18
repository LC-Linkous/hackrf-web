"""WebSocket + tiny HTTP server on 127.0.0.1. One SessionManager, many pages.

The HTTP side serves the bundled page (GET /) and /healthz, and answers the
CORS preflight an https page needs to reach loopback. Everything else is the
JSON call/reply/event protocol in PROTOCOL.md.
"""
# SPDX-License-Identifier: GPL-2.0-only
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import secrets
import time
from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qs, urlsplit

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from . import __version__
from .session import BridgeError, SessionManager

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")


class Bridge:
    def __init__(self, dev: Any, *, host: str = "127.0.0.1", port: int = 8765, token: str | None = None,
                 allow_tx: bool = False, tx_max_seconds: float = 30.0, record_dir: str = ".", fake: bool = False, fps: float = 12.0) -> None:
        self.dev, self.host, self.port = dev, host, port
        self.token = token or secrets.token_urlsafe(18)
        self.allow_tx, self.tx_max_seconds, self.record_dir, self.fake, self.fps = allow_tx, tx_max_seconds, record_dir, fake, fps
        self.clients: set[Any] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.sm: SessionManager | None = None

    # ---------------------------------------------------------------- fan-out
    def emit(self, event: str, data: Any) -> None:
        msg = json.dumps({"event": event, "data": data})
        self._broadcast(msg)

    def send_binary(self, data: bytes) -> None:
        self._broadcast(data)

    def _broadcast(self, msg: Any) -> None:
        assert self.loop is not None
        def go() -> None:
            for ws in list(self.clients):
                try:
                    asyncio.ensure_future(ws.send(msg))
                except Exception:
                    self.clients.discard(ws)
        self.loop.call_soon_threadsafe(go)

    # ---------------------------------------------------------------- http
    def process_request(self, connection: Any, request: Any) -> Response | None:
        path = urlsplit(request.path).path
        if request.headers.get("Upgrade", "").lower() == "websocket":
            q = parse_qs(urlsplit(request.path).query)
            if q.get("token", [None])[0] != self.token:
                return connection.respond(HTTPStatus.UNAUTHORIZED, "bad token\n")
            return None
        method = getattr(request, "method", "GET")
        cors = Headers([("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Private-Network", "true"),
                        ("Access-Control-Allow-Headers", "*"), ("Access-Control-Allow-Methods", "GET, OPTIONS")])
        if method == "OPTIONS":
            return Response(HTTPStatus.NO_CONTENT.value, "No Content", cors, b"")
        if path == "/healthz":
            body = json.dumps({"tool": "hackrf-web", "version": __version__, "fake": self.fake, "allow_tx": self.allow_tx}).encode()
            cors["Content-Type"] = "application/json"
            return Response(200, "OK", cors, body)
        # static page (option B): bundled web/ next to this file
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.normpath(WEB_DIR)) or not os.path.isfile(full):
            if not os.path.isdir(WEB_DIR):
                return Response(404, "Not Found", cors, b"The page is not bundled with this bridge build; open https://lc-linkous.github.io/hackrf-web/ instead.\n")
            return Response(404, "Not Found", cors, b"not found\n")
        with open(full, "rb") as fh:
            body = fh.read()
        cors["Content-Type"] = mimetypes.guess_type(full)[0] or "application/octet-stream"
        cors["Cache-Control"] = "no-cache"
        return Response(200, "OK", cors, body)

    # ---------------------------------------------------------------- ws
    async def handler(self, ws: Any) -> None:
        assert self.sm is not None
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({"event": "hello", "data": {"version": __version__, "allow_tx": self.allow_tx, "fake": self.fake, "tx_max_seconds": self.tx_max_seconds, "page_version_expected": "0.1"}}))
            await ws.send(json.dumps({"event": "session", "data": {"state": self.sm.state, "mode": self.sm.mode, "settings": self.sm.settings}}))
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    await ws.send(json.dumps({"id": None, "error": {"code": "bad_request", "message": "not JSON"}}))
                    continue
                asyncio.ensure_future(self._dispatch(ws, msg))
        finally:
            self.clients.discard(ws)

    async def _dispatch(self, ws: Any, msg: dict[str, Any]) -> None:
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        try:
            result = await self.call(method, params)
            if isinstance(result, bytes):
                await ws.send(result)
                await ws.send(json.dumps({"id": mid, "result": {"binary": True}}))
            else:
                await ws.send(json.dumps({"id": mid, "result": result}))
        except BridgeError as e:
            await ws.send(json.dumps({"id": mid, "error": {"code": e.code, "message": e.message, "detail": e.detail}}))
        except Exception as e:
            await ws.send(json.dumps({"id": mid, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}}))

    async def call(self, method: str | None, p: dict[str, Any]) -> Any:
        sm = self.sm
        assert sm is not None
        if method == "device.preflight":
            sm.require_idle("device.preflight")
            rep = await asyncio.to_thread(self.dev.preflight, self.record_dir)
            rep["bridge"] = {"version": __version__, "allow_tx": self.allow_tx, "fake": self.fake, "record_dir": os.path.abspath(self.record_dir)}
            return rep
        if method == "device.detect":
            sm.require_idle("device.detect")
            return await asyncio.to_thread(self.dev.detect)
        if method == "device.info":
            sm.require_idle("device.info")
            return {"text": await asyncio.to_thread(self.dev.info, True)}
        if method == "session.start":
            return await asyncio.to_thread(sm.start, p)
        if method == "session.stop":
            return await asyncio.to_thread(sm.stop)
        if method == "session.kill":
            return sm.kill()
        if method == "session.status":
            return sm.status()
        if method == "iq.snapshot":
            return sm.snapshot(int(p.get("count", 16384)))
        if method == "record.start":
            return sm.record_start(p.get("max_seconds", 0))
        if method == "record.stop":
            return sm.record_stop()
        if method == "record.status":
            return sm.record_status()
        if method == "tx.tone":
            return await asyncio.to_thread(sm.tx_tone, p)
        if method == "tx.stop":
            return sm.tx_stop()
        if method == "bridge.ping":
            return {"t": time.time()}
        raise BridgeError("bad_request", f"unknown method {method!r}")

    # ---------------------------------------------------------------- run
    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.sm = SessionManager(self.dev, self.loop, emit=self.emit, send_binary=self.send_binary, allow_tx=self.allow_tx,
                                 tx_max_seconds=self.tx_max_seconds, record_dir=self.record_dir, fps=self.fps)
        async with serve(self.handler, self.host, self.port, process_request=self.process_request, max_size=16 * 1024 * 1024) as server:
            await server.serve_forever()

    def page_url(self, base: str | None) -> str:
        frag = f"#bridge={self.host}:{self.port}&token={self.token}"
        return (base.rstrip("/") + "/" if base else f"http://{self.host}:{self.port}/") + frag
