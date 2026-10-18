"""A simulated HackRF with the slice of the hackrfpy API the bridge uses.

Sweep rows mimic hackrf_sweep CSV rows (out of frequency order, one timestamp
per pass); IQ blocks are 8-bit-quantised complex64 with FM broadcast
carriers, a keyed 433.92 MHz transmitter and Gaussian noise. Every state
transition in the bridge is exercised for real; only the samples are made up.
"""
# SPDX-License-Identifier: GPL-2.0-only
from __future__ import annotations

import math
import shutil
import time
from typing import Any, Generator

import numpy as np

SIGNALS = [  # (centre Hz, level dBFS, kind, bandwidth Hz)
    (98.1e6, -22.0, "wfm", 180e3),
    (103.7e6, -30.0, "wfm", 180e3),
    (101.3e6, -42.0, "wfm", 180e3),
    (433.92e6, -18.0, "ook", 20e3),
    (462.5625e6, -55.0, "nfm", 12.5e3),
    (868.3e6, -60.0, "nfm", 25e3),
    (2.437e9, -48.0, "wide", 20e6),
]
NOISE_DBFS = -72.0


def _snap(v: float, lo: int, hi: int, step: int) -> int:
    return int(min(hi, max(lo, round(v / step) * step)))


class _FakeReceiver:
    def __init__(self, dev: "FakeHackRF", freq: float, sample_rate: float) -> None:
        self.dev, self.freq, self.sample_rate = dev, float(freq), float(sample_rate)
        self._closed = False
        self._t = 0
        self.total_samples = 0

    def read(self, n: int) -> np.ndarray:
        if self._closed:
            raise RuntimeError("receiver is closed")
        # pace like hardware: n samples take n / sample_rate seconds
        time.sleep(n / self.sample_rate)
        t = (self._t + np.arange(n)) / self.sample_rate
        self._t += n
        x = np.zeros(n, dtype=np.complex64)
        now = time.time()
        for fc, lvl, kind, bw in SIGNALS:
            off = fc - self.freq
            if abs(off) > self.sample_rate * 0.6:
                continue
            amp = 10 ** (lvl / 20)
            if kind == "ook" and (math.sin(now * 1.3) < 0):
                continue
            if kind in ("wfm", "nfm"):
                dev = 75e3 if kind == "wfm" else 2.5e3
                m = np.sin(2 * np.pi * 1e3 * t) + 0.5 * np.sin(2 * np.pi * 3.3e3 * t)
                ph = 2 * np.pi * off * t + 2 * np.pi * dev * np.cumsum(m) / self.sample_rate
            elif kind == "wide":
                ph = 2 * np.pi * off * t + np.random.uniform(0, 2 * np.pi, n)
            else:
                ph = 2 * np.pi * off * t
            x += (amp * np.exp(1j * ph)).astype(np.complex64)
        noise = 10 ** (NOISE_DBFS / 20) * math.sqrt(self.sample_rate / 2e6)
        x += (np.random.normal(0, noise, n) + 1j * np.random.normal(0, noise, n)).astype(np.complex64)
        x += 0.02  # the DC spike every HackRF has
        q = np.clip(np.rint(x.real * 128), -128, 127) + 1j * np.clip(np.rint(x.imag * 128), -128, 127)
        self.total_samples += n
        return (q / 128.0).astype(np.complex64)

    def close(self) -> None:
        self._closed = True

    stop = close

    def is_alive(self) -> bool:
        return not self._closed


class FakeHackRF:
    """Duck-types the hackrfpy.HackRF surface the bridge calls."""

    def __init__(self) -> None:
        self._mode = "rx"
        self.last_params: dict[str, Any] | None = None
        self.verboseEnabled = False

    # ---- identity / environment
    def preflight(self, capture_path: str = ".") -> dict[str, Any]:
        return {
            "tools": {"hackrf_info": "(fake)", "hackrf_transfer": "(fake)", "hackrf_sweep": "(fake)"},
            "boards": [self._board()], "mode": self._mode, "tool_version": "fake 2026.01.1",
            "disk_free_bytes": shutil.disk_usage(capture_path).free,
            "features": {"sweep_num_sweeps": True, "stdout_stream": True}, "problems": [],
        }

    doctor = preflight

    def detect(self) -> dict[str, Any]:
        return {"found": True, "ready": True, "count": 1, "boards": [self._board()], "tools_version": "fake", "problem": None}

    def info(self, raw: bool = False) -> str:
        return "hackrf_info version: fake\nFound HackRF\nIndex: 0\nSerial number: 0000000000000000f4ke0000deadbeef\nBoard ID Number: 2 (HackRF One)\nFirmware Version: 2024.02.1 (fake)\n"

    @staticmethod
    def _board() -> dict[str, Any]:
        return {"index": 0, "serial": "0000000000000000f4ke0000deadbeef", "name": "HackRF One (simulated)", "firmware": "2024.02.1 (fake)", "firmware_version": "2024.02.1", "is_hackrf": True}

    # ---- mode
    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, value: str) -> str:
        self._mode = value
        return value

    # ---- sweep
    def sweep(self, f_min_hz: float, f_max_hz: float, *, bin_width: float | None = None, lna: int = 16, vga: int = 20, amp: bool = False, **_: Any) -> Generator[dict[str, Any], None, None]:
        lo, hi = int(f_min_hz // 1e6), -int(-f_max_hz // 1e6)
        bw = float(bin_width or 100e3)
        lna, vga = _snap(lna, 0, 40, 8), _snap(vga, 0, 62, 2)
        self.last_params = {"f_min": lo * 1e6, "f_max": hi * 1e6, "lna": lna, "vga": vga, "amp": amp, "bin_width": bw, "mode": "rx"}
        seg = 5_000_000  # hackrf_sweep's 5 MHz segments at 20 Msps
        nseg = max(1, math.ceil((hi - lo) * 1e6 / seg))
        order = list(range(nseg))
        while True:
            stamp = time.strftime("%Y-%m-%d, %H:%M:%S") + f".{int(time.time() * 1e6) % 1000000:06d}"
            # interleaved order like the real tool: odd segments first, then even
            for i in order[1::2] + order[0::2]:
                a = lo * 1e6 + i * seg
                b = min(a + seg, hi * 1e6)
                nb = max(1, int(round((b - a) / bw)))
                f = a + bw * (np.arange(nb) + 0.5)
                db = np.full(nb, NOISE_DBFS - 10 + 2 * (f / 6e9), dtype=np.float32) + np.random.normal(0, 1.2, nb)
                now = time.time()
                for fc, lvl, kind, sbw in SIGNALS:
                    if kind == "ook" and math.sin(now * 1.3) < 0:
                        continue
                    d = (f - fc) / max(sbw / 2, bw)
                    db = np.maximum(db, lvl - 10 * np.log10(1 + d * d * 3) + (lna + vga - 36) * 0.0)
                yield {"date": stamp.split(", ")[0], "time": stamp.split(", ")[1], "hz_low": int(a), "hz_high": int(b), "bin_width": bw, "num_samples": 8192, "db": db.tolist()}
                time.sleep(0.004)
            time.sleep(0.02)

    # ---- iq
    def open_receiver(self, freq: float, sample_rate: float, *, lna: int = 16, vga: int = 20, amp: bool = False, **_: Any) -> _FakeReceiver:
        self.last_params = {"freq": float(freq), "sample_rate": float(sample_rate), "lna": _snap(lna, 0, 40, 8), "vga": _snap(vga, 0, 62, 2), "amp": amp, "baseband_bw": sample_rate * 0.75, "mode": "rx"}
        return _FakeReceiver(self, freq, sample_rate)

    @staticmethod
    def decode_iq(raw: bytes) -> np.ndarray:
        a = np.frombuffer(raw, dtype=np.int8)
        iq = np.empty(a.size // 2, dtype=np.complex64)
        iq.real = a[0::2]; iq.imag = a[1::2]
        return iq / 128.0

    def estimate_capture(self, sample_rate: float, num_samples: int | None = None, duration: float | None = None, path: str = ".") -> dict[str, Any]:
        bps = sample_rate * 2
        total = int(bps * duration) if duration is not None else (num_samples * 2 if num_samples else None)
        return {"bytes_per_sec": bps, "total_bytes": total, "seconds": duration, "free_bytes": shutil.disk_usage(path).free}

    # ---- tx
    def transmit_cw(self, freq: float, sample_rate: float, *, amplitude: int = 127, txvga: int = 20, amp: bool = False, duration: float | None = None, **_: Any) -> Any:
        if self._mode != "tx":
            raise RuntimeError("transmit requires TX mode")
        self.last_params = {"freq": freq, "sample_rate": sample_rate, "txvga": txvga, "amp": amp, "amplitude": amplitude, "mode": "tx"}
        return _FakeTx(duration or 0)


class _FakeTx:
    def __init__(self, duration: float) -> None:
        self._end = time.time() + duration
        self._stopped = False

    def is_alive(self) -> bool:
        return not self._stopped and time.time() < self._end

    def stop(self, grace: float = 2.0) -> tuple[bytes, bytes, int | None]:
        self._stopped = True
        return b"", b"", 0

    def wait(self) -> tuple[bytes, bytes, int | None]:
        while self.is_alive():
            time.sleep(0.05)
        return b"", b"", 0
