# Smoke test: drives a running bridge (--fake, --token ci, --port 8790) through sweep, IQ, snapshot, recording and the TX gate.
# SPDX-License-Identifier: GPL-2.0-only
import asyncio, json, struct, time, websockets
async def main():
    async with websockets.connect("ws://127.0.0.1:8790/?token=" + __import__("os").environ.get("HRF_TOKEN", "ci") + "", max_size=2**24) as ws:
        n = 0
        async def call(m, p=None):
            await ws.send(json.dumps({"id": m, "method": m, "params": p or {}}))
        async def recv_until(pred, timeout=8):
            t0 = time.time(); frames = []
            while time.time() - t0 < timeout:
                raw = await asyncio.wait_for(ws.recv(), timeout)
                if isinstance(raw, bytes):
                    hl = struct.unpack("<I", raw[:4])[0]; h = json.loads(raw[4:4+hl]); frames.append((h, len(raw)-4-hl))
                    if pred(h, None): return frames
                else:
                    m = json.loads(raw)
                    if pred(None, m): return frames + [m]
            return frames
        print(await recv_until(lambda h, m: m and m.get("event") == "session"))
        await call("device.preflight"); r = await recv_until(lambda h, m: m and m.get("id") == "device.preflight"); print("preflight problems:", r[-1]["result"]["problems"], r[-1]["result"]["bridge"])
        await call("session.start", {"mode": "sweep", "f_min": 88e6, "f_max": 108e6, "bin_width": 100e3})
        r = await recv_until(lambda h, m: m and m.get("id") == "session.start"); print("start:", r[-1])
        fr = await recv_until(lambda h, m: h is not None and h["seq"] >= 5, 15); specs = [f for f in fr if isinstance(f, tuple)]; print("sweep frames:", len(specs), specs[-1][0]["points"], specs[-1][0]["start"], specs[-1][0]["stop"], "payload", specs[-1][1])
        await call("session.stop"); r = await recv_until(lambda h, m: m and m.get("id") == "session.stop"); print("stop:", r[-1])
        await call("session.start", {"mode": "iq", "center": 98.1e6, "sample_rate": 8e6, "fft_size": 2048, "avg": 2})
        r = await recv_until(lambda h, m: m and m.get("id") == "session.start"); print("iq start:", r[-1].get("result", r[-1].get("error")))
        fr = await recv_until(lambda h, m: h is not None and h["seq"] >= 5, 15); specs = [f for f in fr if isinstance(f, tuple)]; print("iq frames:", len(specs), specs[-1][0]["points"], specs[-1][0]["bin_width"], "dropped", specs[-1][0]["dropped"])
        await call("record.start", {"max_seconds": 1.0}); r = await recv_until(lambda h, m: m and m.get("id") == "record.start"); print("rec:", r[-1])
        await asyncio.sleep(1.6)
        await call("iq.snapshot", {"count": 4096}); fr = await recv_until(lambda h, m: h is not None and h.get("kind") == "iq"); print("snapshot:", [f[0]["count"] for f in fr if isinstance(f, tuple) and f[0].get("kind") == "iq"])
        await call("record.status"); r = await recv_until(lambda h, m: m and m.get("id") == "record.status"); print("rec status:", r[-1])
        await call("tx.tone", {"freq": 433.92e6, "duration": 1, "confirm": True}); r = await recv_until(lambda h, m: m and m.get("id") == "tx.tone"); print("tx (expect not_allowed):", r[-1])
        await call("session.stop"); r = await recv_until(lambda h, m: m and m.get("id") == "session.stop"); print("stop:", r[-1])
        await call("session.status"); r = await recv_until(lambda h, m: m and m.get("id") == "session.status"); print("status:", r[-1]["result"]["state"], r[-1]["result"]["recording"])
asyncio.run(main())
