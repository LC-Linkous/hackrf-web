"""The session manager: one child process at a time, every transition through idle.

States: idle | sweep | iq | tx (PROTOCOL.md). Worker threads drain hackrfpy
generators and hand frames to the asyncio loop; nothing here blocks the loop.
"""
# SPDX-License-Identifier: GPL-2.0-only
from __future__ import annotations

import asyncio
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .frames import IqSpectrum, SweepStitcher, iq_to_int8, pack_frame


class BridgeError(Exception):
    def __init__(self, code: str, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


@dataclass
class Recording:
    path: str
    fh: Any
    started: float
    sample_rate: float
    max_seconds: float
    bytes: int = 0
    settings: dict[str, Any] = field(default_factory=dict)


class SessionManager:
    def __init__(self, dev: Any, loop: asyncio.AbstractEventLoop, *, emit: Callable[[str, Any], None],
                 send_binary: Callable[[bytes], None], allow_tx: bool, tx_max_seconds: float, record_dir: str, fps: float = 12.0) -> None:
        self.dev, self.loop, self.emit, self.send_binary = dev, loop, emit, send_binary
        self.allow_tx, self.tx_max_seconds, self.record_dir, self.fps = allow_tx, tx_max_seconds, record_dir, fps
        self.state = "idle"
        self.mode: str | None = None
        self.settings: dict[str, Any] = {}
        self.since = 0.0
        self.seq = 0
        self.dropped = 0
        self._frames_sec: list[float] = []
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._rx: Any = None
        self._tx: Any = None
        self._lock = threading.Lock()
        self._latest_iq: np.ndarray | None = None
        self._rec: Recording | None = None
        self._last_err: str | None = None

    # ---------------------------------------------------------------- helpers
    def _post(self, fn: Callable[[], None]) -> None:
        self.loop.call_soon_threadsafe(fn)

    def _set_state(self, state: str, reason: str | None = None) -> None:
        self.state = state
        d: dict[str, Any] = {"state": state, "mode": self.mode, "settings": self.settings}
        if reason:
            d["reason"] = reason
        self.emit("session", d)

    def status(self) -> dict[str, Any]:
        now = time.time()
        self._frames_sec = [t for t in self._frames_sec if now - t < 2.0]
        return {"state": self.state, "mode": self.mode, "settings": self.settings, "seq": self.seq,
                "fps": round(len(self._frames_sec) / 2.0, 1), "dropped": self.dropped, "since": self.since,
                "recording": self.record_status(), "last_error": self._last_err}

    def require_idle(self, what: str) -> None:
        if self.state != "idle":
            raise BridgeError("busy", f"{what} needs an idle session (state is {self.state}); stop it first")

    # ---------------------------------------------------------------- start / stop
    def start(self, params: dict[str, Any]) -> dict[str, Any]:
        self.require_idle("session.start")
        mode = params.get("mode")
        if mode not in ("sweep", "iq"):
            raise BridgeError("bad_request", "mode must be 'sweep' or 'iq'")
        self._stop.clear()
        self.seq = 0; self.dropped = 0; self._frames_sec = []; self._last_err = None
        self.mode = mode; self.since = time.time()
        try:
            if mode == "sweep":
                self.settings = self._start_sweep(params)
            else:
                self.settings = self._start_iq(params)
        except BridgeError:
            self.mode = None
            raise
        except Exception as e:  # hackrfpy typed errors map by class name
            self.mode = None
            raise BridgeError(_code_for(e), str(e)) from e
        self._set_state(mode)
        return {"state": self.state, "mode": mode, "settings": self.settings}

    def _start_sweep(self, p: dict[str, Any]) -> dict[str, Any]:
        f_min, f_max = float(p.get("f_min", 88e6)), float(p.get("f_max", 108e6))
        if not f_min < f_max:
            raise BridgeError("bad_request", "f_min must be below f_max")
        kw: dict[str, Any] = {"lna": int(p.get("lna", 16)), "vga": int(p.get("vga", 20)), "amp": bool(p.get("amp", False))}
        if p.get("bin_width"):
            kw["bin_width"] = float(p["bin_width"])
        gen = self.dev.sweep(f_min, f_max, **kw)
        # sweep() is a generator: hackrfpy records last_params on the first row, so snap here the same way it will
        lp = {"f_min": (f_min // 1e6) * 1e6, "f_max": -(-f_max // 1e6) * 1e6, "lna": _snap(kw["lna"], 0, 40, 8), "vga": _snap(kw["vga"], 0, 62, 2), "amp": kw["amp"], "bin_width": kw.get("bin_width")}
        self.emit("log", {"level": "info", "text": f"hackrf_sweep {lp.get('f_min', f_min)/1e6:.0f}:{lp.get('f_max', f_max)/1e6:.0f} MHz lna {lp.get('lna')} vga {lp.get('vga')} amp {int(bool(lp.get('amp')))}" + (f" bin {lp.get('bin_width'):.0f} Hz" if lp.get('bin_width') else "")})
        settings = {"mode": "sweep", "f_min": lp.get("f_min", f_min), "f_max": lp.get("f_max", f_max), "lna": lp.get("lna"), "vga": lp.get("vga"), "amp": bool(lp.get("amp")), "bin_width": lp.get("bin_width"), "level_unit": "dBFS"}
        self._thread = threading.Thread(target=self._sweep_worker, args=(gen, settings), daemon=True, name="sweep")
        self._thread.start()
        return settings

    def _sweep_worker(self, gen: Any, settings: dict[str, Any]) -> None:
        st = SweepStitcher()
        last_sent = 0.0
        try:
            for row in gen:
                if self._stop.is_set():
                    break
                fr = st.push(row)
                if fr is None:
                    continue
                now = time.time()
                if now - last_sent < 1.0 / self.fps:
                    self.dropped += 1
                    continue
                last_sent = now
                self._send_spectrum(fr, settings)
        except Exception as e:
            self._post(lambda: self._failed(e))
        finally:
            try:
                gen.close()
            except Exception:
                pass
            self._post(lambda: self._ended("sweep"))

    def _start_iq(self, p: dict[str, Any]) -> dict[str, Any]:
        center, sr = float(p.get("center", 98.1e6)), float(p.get("sample_rate", 8e6))
        fft_size = int(p.get("fft_size", 2048)); avg = int(p.get("avg", 4))
        if fft_size & (fft_size - 1) or not 256 <= fft_size <= 8192:
            raise BridgeError("bad_request", "fft_size must be a power of two between 256 and 8192")
        rx = self.dev.open_receiver(center, sr, lna=int(p.get("lna", 16)), vga=int(p.get("vga", 20)), amp=bool(p.get("amp", False)))
        # open the stream now so bad parameters fail here, not in the thread
        first = rx.read(max(fft_size, 8192))
        lp = dict(self.dev.last_params or {})
        self.emit("log", {"level": "info", "text": f"hackrf_transfer -r - -f {int(lp.get('freq', center))} -s {int(lp.get('sample_rate', sr))} -l {lp.get('lna')} -g {lp.get('vga')} -a {int(bool(lp.get('amp')))}"})
        settings = {"mode": "iq", "center": lp.get("freq", center), "sample_rate": lp.get("sample_rate", sr), "lna": lp.get("lna"), "vga": lp.get("vga"), "amp": bool(lp.get("amp")),
                    "baseband_bw": lp.get("baseband_bw"), "fft_size": fft_size, "avg": avg, "rbw": lp.get("sample_rate", sr) / fft_size * 1.5, "level_unit": "dBFS"}
        self._rx = rx
        self._latest_iq = first
        self._thread = threading.Thread(target=self._iq_worker, args=(rx, settings, first), daemon=True, name="iq")
        self._thread.start()
        return settings

    def _iq_worker(self, rx: Any, settings: dict[str, Any], first: np.ndarray) -> None:
        spec = IqSpectrum(settings["fft_size"], settings["avg"])
        block = max(settings["fft_size"], 16384)
        last_sent = 0.0
        center, sr = settings["center"], settings["sample_rate"]
        try:
            iq = first
            while not self._stop.is_set():
                with self._lock:
                    self._latest_iq = iq
                    rec = self._rec
                if rec is not None:
                    raw = iq_to_int8(iq)
                    rec.fh.write(raw.tobytes()); rec.bytes += raw.nbytes
                    if time.time() - rec.started >= rec.max_seconds:
                        self._post(self.record_stop)
                out = spec.push(iq)
                if out is not None:
                    now = time.time()
                    if now - last_sent >= 1.0 / self.fps:
                        last_sent = now
                        fr = {"seq": spec.seq, "t": now, "start": center - sr / 2, "stop": center + sr / 2, "points": len(out), "bin_width": sr / len(out), "level": out}
                        self._send_spectrum(fr, settings)
                    else:
                        self.dropped += 1
                iq = rx.read(block)
                if len(iq) < block:  # stream ended
                    raise RuntimeError("receive stream ended (child exited)")
        except Exception as e:
            self._post(lambda: self._failed(e))
        finally:
            try:
                rx.close()
            except Exception:
                pass
            self._post(lambda: self._ended("iq"))

    def _send_spectrum(self, fr: dict[str, Any], settings: dict[str, Any]) -> None:
        self.seq = fr["seq"]
        self._frames_sec.append(fr["t"])
        head = {"kind": "spectrum", "seq": fr["seq"], "t": fr["t"], "start": fr["start"], "stop": fr["stop"], "points": fr["points"],
                "bin_width": fr["bin_width"], "level_unit": settings.get("level_unit", "dBFS"), "mode": settings["mode"], "settings": settings, "dropped": self.dropped}
        data = pack_frame(head, np.ascontiguousarray(fr["level"], dtype=np.float32))
        self._post(lambda: self.send_binary(data))

    def _failed(self, e: Exception) -> None:
        self._last_err = f"{type(e).__name__}: {e}"
        self.emit("device", {"status": "unresponsive" if "ended" in str(e) else "lost", "stderr": str(e)})
        self.emit("log", {"level": "error", "text": self._last_err})

    def _ended(self, mode: str) -> None:
        if self.state == mode:
            if self._rec is not None:
                self.record_stop()
            self._rx = None; self._thread = None
            self._set_state("idle", reason=self._last_err or "stopped")

    def stop(self) -> dict[str, Any]:
        if self.state == "tx":
            return self.tx_stop()
        if self.state == "idle":
            return {"state": "idle"}
        self._stop.set()
        rx = self._rx
        if rx is not None:
            try:
                rx.close()
            except Exception:
                pass
        t = self._thread
        if t is not None:
            t.join(timeout=5.0)
        if self.state != "idle":  # the worker's _ended may still be queued; force it
            if self._rec is not None:
                self.record_stop()
            self._rx = None; self._thread = None
            self._set_state("idle", reason="stopped")
        return {"state": "idle"}

    def kill(self) -> dict[str, Any]:
        self._stop.set()
        for h in (self._rx, self._tx):
            if h is not None:
                try:
                    h.stop()
                except Exception:
                    pass
        self._rx = self._tx = None; self._thread = None
        if self._rec is not None:
            self.record_stop()
        self._set_state("idle", reason="killed")
        return {"state": "idle"}

    # ---------------------------------------------------------------- iq snapshot
    def snapshot(self, count: int) -> bytes:
        if self.state != "iq":
            raise BridgeError("busy", "iq.snapshot needs a running IQ session")
        count = int(min(max(count, 256), 65536))
        with self._lock:
            iq = self._latest_iq
        if iq is None:
            raise BridgeError("internal", "no block yet")
        iq = iq[-count:]
        head = {"kind": "iq", "seq": self.seq, "t": time.time(), "center": self.settings["center"], "sample_rate": self.settings["sample_rate"], "count": len(iq), "settings": self.settings}
        return pack_frame(head, iq_to_int8(iq))

    # ---------------------------------------------------------------- recording
    def record_start(self, max_seconds: float) -> dict[str, Any]:
        if self.state != "iq":
            raise BridgeError("busy", "record.start needs a running IQ session (sweep recordings are made by the page)")
        if self._rec is not None:
            raise BridgeError("busy", "already recording")
        max_seconds = float(max_seconds)
        if not 0 < max_seconds <= 3600:
            raise BridgeError("bad_request", "max_seconds must be between 0 and 3600")
        sr = float(self.settings["sample_rate"])
        try:
            est = self.dev.estimate_capture(sr, duration=max_seconds, path=self.record_dir)
        except Exception as e:
            raise BridgeError("environment", str(e)) from e
        os.makedirs(self.record_dir, exist_ok=True)
        path = os.path.join(self.record_dir, time.strftime("hackrf-%Y-%m-%d-%H-%M-%S") + ".iq")
        fh = open(path, "wb")
        with self._lock:
            self._rec = Recording(path=path, fh=fh, started=time.time(), sample_rate=sr, max_seconds=max_seconds, settings=dict(self.settings))
        self.emit("record", self.record_status())
        self.emit("log", {"level": "info", "text": f"recording to {path} (≤ {max_seconds:.0f} s, ~{est['total_bytes']/1e6:.0f} MB)"})
        return self.record_status()

    def record_stop(self) -> dict[str, Any]:
        with self._lock:
            rec, self._rec = self._rec, None
        if rec is None:
            return {"active": False}
        rec.fh.close()
        seconds = rec.bytes / (2 * rec.sample_rate)
        try:
            from hackrfpy.sigmf import write_sigmf_meta  # type: ignore
            write_sigmf_meta(rec.path, rec.settings["center"], rec.sample_rate, lna=rec.settings.get("lna"), vga=rec.settings.get("vga"), amp=rec.settings.get("amp"), extra={"hackrf-web:bridge": True})
        except Exception as e:
            _write_minimal_sigmf(rec, e)
        d = {"active": False, "path": rec.path, "bytes": rec.bytes, "seconds": round(seconds, 3)}
        self.emit("record", d)
        self.emit("log", {"level": "info", "text": f"recorded {rec.bytes/1e6:.1f} MB ({seconds:.1f} s) → {rec.path}"})
        return d

    def record_status(self) -> dict[str, Any]:
        with self._lock:
            rec = self._rec
        if rec is None:
            return {"active": False}
        return {"active": True, "path": rec.path, "bytes": rec.bytes, "seconds": round(time.time() - rec.started, 1), "max_seconds": rec.max_seconds}

    # ---------------------------------------------------------------- transmit
    def tx_tone(self, p: dict[str, Any]) -> dict[str, Any]:
        if not self.allow_tx:
            raise BridgeError("not_allowed", "transmit is disabled: start the bridge with --allow-tx")
        if not p.get("confirm") is True:
            raise BridgeError("not_allowed", "tx.tone needs confirm: true")
        dur = p.get("duration")
        if dur is None or not 0 < float(dur) <= self.tx_max_seconds:
            raise BridgeError("bad_request", f"duration is required and must be ≤ {self.tx_max_seconds} s")
        self.require_idle("tx.tone")
        freq, sr = float(p.get("freq", 433.92e6)), float(p.get("sample_rate", 2e6))
        txvga, amplitude, amp = int(p.get("txvga", 0)), int(p.get("amplitude", 64)), bool(p.get("amp", False))
        try:
            self.dev.set_mode("tx")
            handle = self.dev.transmit_cw(freq, sr, amplitude=amplitude, txvga=txvga, amp=amp, duration=float(dur))
        except Exception as e:
            try:
                self.dev.set_mode("rx")
            except Exception:
                pass
            raise BridgeError(_code_for(e), str(e)) from e
        self._tx = handle
        self.mode = "tx"
        self.settings = {"mode": "tx", "freq": freq, "sample_rate": sr, "txvga": txvga, "amplitude": amplitude, "amp": amp, "duration": float(dur)}
        self.since = time.time()
        self._set_state("tx")
        self.emit("log", {"level": "warn", "text": f"TRANSMITTING {freq/1e6:.4f} MHz txvga {txvga} amp {int(amp)} for {float(dur):.0f} s"})
        self.loop.create_task(self._tx_watch(handle, float(dur)))
        return {"state": "tx", "settings": self.settings}

    async def _tx_watch(self, handle: Any, duration: float) -> None:
        end = time.time() + duration
        while self.state == "tx" and self._tx is handle:
            left = end - time.time()
            alive = handle is not None and getattr(handle, "is_alive", lambda: False)()
            self.emit("tx", {"on": True, "freq": self.settings.get("freq"), "seconds_left": max(0.0, round(left, 1))})
            if left <= 0 or not alive:
                break
            await asyncio.sleep(1.0)
        if self._tx is handle:
            self.tx_stop()

    def tx_stop(self) -> dict[str, Any]:
        h, self._tx = self._tx, None
        if h is not None:
            try:
                h.stop()
            except Exception:
                pass
        try:
            self.dev.set_mode("rx")
        except Exception:
            pass
        if self.state == "tx":
            self.emit("tx", {"on": False})
            self._set_state("idle", reason="transmit ended")
        return {"state": "idle"}


def _snap(v: float, lo: int, hi: int, step: int) -> int:
    return int(min(hi, max(lo, round(v / step) * step)))


def _code_for(e: Exception) -> str:
    n = type(e).__name__
    s = str(e).lower()
    if "busy" in s or "resource busy" in s:
        return "device_busy"
    if "no hackrf" in s or "not found" in s and "board" in s:
        return "device_missing"
    return {"HackRFValueError": "bad_request", "HackRFModeError": "not_allowed", "HackRFEnvironmentError": "environment", "HackRFDeviceError": "device_missing"}.get(n, "internal")


def _write_minimal_sigmf(rec: Recording, err: Exception) -> None:
    import json
    base = os.path.splitext(rec.path)[0]
    meta = {"global": {"core:datatype": "ci8", "core:sample_rate": rec.sample_rate, "core:hw": "HackRF One", "core:recorder": "hackrf-web", "core:version": "1.0.0", "hackrf-web:note": f"hackrfpy.sigmf unavailable ({err})"},
            "captures": [{"core:sample_start": 0, "core:frequency": rec.settings.get("center"), "core:datetime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(rec.started))}], "annotations": []}
    with open(base + ".sigmf-meta", "w") as fh:
        json.dump(meta, fh, indent=2)
