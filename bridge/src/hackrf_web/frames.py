"""Binary frames and the two spectrum pipelines (sweep stitching, IQ FFT).

Frame layout (PROTOCOL.md): uint32 LE header length, UTF-8 JSON header, payload.
"""
# SPDX-License-Identifier: GPL-2.0-only
from __future__ import annotations

import json
import struct
import time
from typing import Any

import numpy as np


def pack_frame(header: dict[str, Any], payload: np.ndarray | bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = payload.tobytes() if isinstance(payload, np.ndarray) else payload
    return struct.pack("<I", len(h)) + h + body


# ---------------------------------------------------------------- sweep mode

class SweepStitcher:
    """Group hackrf_sweep rows into whole sweeps.

    Rows arrive out of frequency order (hackrf_sweep interleaves segments) and
    all rows of one pass share a timestamp. A pass is complete when the next
    row's timestamp differs, or when a segment's hz_low repeats.
    """

    def __init__(self) -> None:
        self._stamp: str | None = None
        self._rows: list[dict[str, Any]] = []
        self.seq = 0

    def push(self, row: dict[str, Any]) -> dict[str, Any] | None:
        stamp = f"{row.get('date')} {row.get('time')}"
        done = None
        if self._rows and (stamp != self._stamp or any(r["hz_low"] == row["hz_low"] for r in self._rows)):
            done = self._finish()
        self._stamp = stamp
        self._rows.append(row)
        return done

    def flush(self) -> dict[str, Any] | None:
        return self._finish() if self._rows else None

    def _finish(self) -> dict[str, Any] | None:
        rows = sorted(self._rows, key=lambda r: r["hz_low"])
        self._rows = []
        if not rows:
            return None
        bw = float(rows[0]["bin_width"])
        level = np.concatenate([np.asarray(r["db"], dtype=np.float32) for r in rows])
        start = float(rows[0]["hz_low"])
        stop = start + bw * len(level)
        self.seq += 1
        return {"seq": self.seq, "t": time.time(), "start": start, "stop": stop,
                "points": int(len(level)), "bin_width": bw, "level": level}


# ---------------------------------------------------------------- iq mode

class IqSpectrum:
    """Windowed FFT of complex64 blocks with power averaging. Returns dBFS."""

    def __init__(self, fft_size: int = 2048, avg: int = 4) -> None:
        self.n = int(fft_size)
        self.avg = max(1, int(avg))
        self.win = np.hanning(self.n).astype(np.float32)
        # 0 dBFS = a full-scale complex tone (|x| = 1) → window-gain corrected
        self._gain = float(np.sum(self.win)) ** 2
        self._acc: np.ndarray | None = None
        self._count = 0
        self.seq = 0

    def push(self, iq: np.ndarray) -> np.ndarray | None:
        if len(iq) < self.n:
            return None
        x = iq[-self.n:] * self.win
        spec = np.fft.fftshift(np.fft.fft(x))
        p = (spec.real ** 2 + spec.imag ** 2) / self._gain
        self._acc = p if self._acc is None else self._acc + p
        self._count += 1
        if self._count < self.avg:
            return None
        out = (10 * np.log10(self._acc / self._count + 1e-20)).astype(np.float32)
        self._acc = None
        self._count = 0
        self.seq += 1
        return out


def iq_to_int8(iq: np.ndarray) -> np.ndarray:
    """Exact inverse of hackrfpy.decode_iq (which divides by 128)."""
    out = np.empty(2 * len(iq), dtype=np.int8)
    out[0::2] = np.clip(np.rint(iq.real * 128.0), -128, 127)
    out[1::2] = np.clip(np.rint(iq.imag * 128.0), -128, 127)
    return out
