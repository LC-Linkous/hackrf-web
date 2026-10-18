// bridge-link.js — WebSocket client for the hackrf-web bridge (PROTOCOL.md).
// SPDX-License-Identifier: GPL-2.0-only
//
// Calls are JSON { id, method, params } → { id, result | error }; events are
// { event, data }; spectrum and IQ frames arrive as binary (uint32 header
// length + JSON header + payload) and are decoded here into typed arrays.

export function parseBinaryFrame(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const body = buf.slice(4 + hl);
  if (head.kind === 'spectrum') head.level = new Float32Array(body);
  else if (head.kind === 'iq') head.iq = new Int8Array(body);
  else head.payload = new Uint8Array(body);
  return head;
}

export class BridgeLink {
  constructor() {
    this.ws = null; this.nextId = 1; this.pending = new Map();
    this.onEvent = null;      // (name, data)
    this.onFrame = null;      // (frame) — spectrum or iq
    this.onTx = null;         // (text) for the console
    this.onRx = null;         // (text) for the console
    this.onClose = null;
    this.hello = null; this.addr = ''; this.closed = false;
  }
  info() { return `ws://${this.addr}`; }

  open(addr, token) {
    this.addr = addr;
    return new Promise((res, rej) => {
      let ws;
      try { ws = new WebSocket(`ws://${addr}/?token=${encodeURIComponent(token)}`); } catch (e) { rej(e); return; }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('no reply from the bridge in 4 s — is `hackrf-web` running?')); }, 4000);
      ws.onopen = () => {};
      ws.onerror = () => {};
      ws.onclose = ev => { clearTimeout(timer); if (!this.hello) rej(new Error(ev.code === 1006 ? 'could not connect to the bridge (connection refused or wrong token)' : `bridge closed the connection (${ev.code})`)); for (const p of this.pending.values()) p.rej(new Error('bridge disconnected')); this.pending.clear(); if (this.onClose && !this.closed) this.onClose(ev); };
      ws.onmessage = ev => {
        if (ev.data instanceof ArrayBuffer) { const f = parseBinaryFrame(ev.data); if (this.onFrame) this.onFrame(f); return; }
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.event) {
          if (m.event === 'hello' && !this.hello) { this.hello = m.data; clearTimeout(timer); res(m.data); }
          if (this.onEvent) this.onEvent(m.event, m.data);
          return;
        }
        const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
        if (m.error) { const e = new Error(m.error.message); e.code = m.error.code; e.detail = m.error.detail; if (this.onRx) this.onRx(`✗ ${p.method}: ${m.error.code} — ${m.error.message}`); p.rej(e); }
        else { if (this.onRx && !p.quiet) this.onRx(`${p.method} → ${summarize(m.result)}`); p.res(m.result); }
      };
      this.ws = ws;
    });
  }
  call(method, params = {}, { quiet = false } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('not connected to the bridge'));
    const id = this.nextId++;
    if (this.onTx && !quiet) this.onTx(`${method} ${JSON.stringify(params)}`);
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, method, quiet }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.closed = true; try { this.ws?.close(); } catch {} }
}

function summarize(r) {
  if (r == null) return 'ok';
  const s = JSON.stringify(r);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}
