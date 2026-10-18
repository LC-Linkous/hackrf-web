// demo-link.js — a bridge that isn't there: replays recorded frames.
// SPDX-License-Identifier: GPL-2.0-only
//
// Same call/event/frame surface as BridgeLink, so main.js can't tell them
// apart. IQ mode replays spectrum frames computed (by the bridge's own FFT
// code) from a real HackRF One recording that ships with hackrfpy's tests:
// 98.1 MHz FM broadcast at 8 Msps. Sweep mode replays frames from the
// bridge's fake device. Recording is simulated (no file is written).
import { parseBinaryFrame } from './bridge-link.js';

const FILES = { iq: 'demo/iq_fm98.bin', sweepFm: 'demo/sweep_fm.bin', sweepWide: 'demo/sweep_wide.bin' };

export class DemoLink {
  constructor() {
    this.onEvent = null; this.onFrame = null; this.onTx = null; this.onRx = null; this.onClose = null;
    this.hello = { version: 'demo', allow_tx: false, fake: true, tx_max_seconds: 0, page_version_expected: '0.1' };
    this.state = 'idle'; this.mode = null; this.settings = {}; this.timer = null; this.seq = 0; this.rec = null; this.cache = {};
    this.addr = 'demo';
  }
  info() { return 'demo (recorded frames)'; }
  async open() { setTimeout(() => this.onEvent?.('hello', this.hello), 0); this._session(); return this.hello; }
  close() { this._stopTimer(); }

  async _load(key) {
    if (this.cache[key]) return this.cache[key];
    const buf = await (await fetch(FILES[key])).arrayBuffer();
    const dv = new DataView(buf), hl = dv.getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const n = head.frames * head.points;
    const frames = new Float32Array(buf.slice(4 + hl, 4 + hl + n * 4));          // slice: the header length isn't 4-aligned
    const snap = head.snapshot ? new Int8Array(buf.slice(4 + hl + n * 4, 4 + hl + n * 4 + head.snapshot * 2)) : null;
    return (this.cache[key] = { head, frames, snap });
  }
  _session(reason) { const d = { state: this.state, mode: this.mode, settings: this.settings }; if (reason) d.reason = reason; this.onEvent?.('session', d); }
  _log(text, level = 'info') { this.onEvent?.('log', { level, text }); }
  _stopTimer() { clearInterval(this.timer); this.timer = null; }
  _err(code, message) { const e = new Error(message); e.code = code; if (this.onRx) this.onRx(`✗ ${code} — ${message}`); throw e; }

  async call(method, p = {}, { quiet = false } = {}) {
    if (this.onTx && !quiet) this.onTx(`${method} ${JSON.stringify(p)}`);
    const r = await this._call(method, p);
    if (this.onRx && !quiet) this.onRx(`${method} → ${JSON.stringify(r).slice(0, 160)}`);
    return r;
  }
  async _call(method, p) {
    switch (method) {
      case 'device.preflight': return { tools: { hackrf_info: '(demo)', hackrf_transfer: '(demo)', hackrf_sweep: '(demo)' }, boards: [{ index: 0, serial: '0000000000000000demo0000deadbeef', name: 'HackRF One (recorded frames)', firmware: '2024.02.1', is_hackrf: true }], mode: 'rx', tool_version: 'demo', disk_free_bytes: 0, features: {}, problems: [], bridge: { version: 'demo', allow_tx: false, fake: true, record_dir: '(none — demo)' } };
      case 'device.detect': return { found: true, ready: true, count: 1, boards: [{ index: 0, serial: 'demo', name: 'HackRF One (recorded frames)', firmware: '2024.02.1', is_hackrf: true }], problem: null };
      case 'device.info': return { text: 'hackrf_info version: demo\nFound HackRF\nIndex: 0\nSerial number: demo\nBoard ID Number: 2 (HackRF One)\nFirmware Version: 2024.02.1\n' };
      case 'session.status': return { state: this.state, mode: this.mode, settings: this.settings, seq: this.seq, fps: this.timer ? 12 : 0, dropped: 0, recording: this._recStatus() };
      case 'session.start': return this._start(p);
      case 'session.stop': case 'session.kill': return this._stop('stopped');
      case 'iq.snapshot': {
        if (this.state !== 'iq') this._err('busy', 'iq.snapshot needs a running IQ session');
        const d = await this._load('iq'); const count = Math.min(p.count || 16384, d.head.snapshot);
        setTimeout(() => this.onFrame?.({ kind: 'iq', seq: this.seq, t: Date.now() / 1000, center: d.head.center, sample_rate: d.head.sample_rate, count, settings: this.settings, iq: d.snap.subarray(0, 2 * count) }), 0);
        return { binary: true };
      }
      case 'record.start': {
        if (this.state !== 'iq') this._err('busy', 'record.start needs a running IQ session');
        this.rec = { started: Date.now(), max: +p.max_seconds || 10, path: '(demo — nothing written)' };
        this._log(`demo recording (simulated) ≤ ${this.rec.max} s`); this.onEvent?.('record', this._recStatus()); return this._recStatus();
      }
      case 'record.stop': { const r = this._recStatus(); this.rec = null; const d = { active: false, path: r.path, bytes: r.bytes, seconds: r.seconds }; this.onEvent?.('record', d); return d; }
      case 'record.status': return this._recStatus();
      case 'tx.tone': this._err('not_allowed', 'the demo cannot transmit (and a real bridge needs --allow-tx)');
      case 'tx.stop': return { state: this.state };
      case 'bridge.ping': return { t: Date.now() / 1000 };
      default: this._err('bad_request', `unknown method ${method}`);
    }
  }
  _recStatus() {
    if (!this.rec) return { active: false };
    const secs = Math.min((Date.now() - this.rec.started) / 1000, this.rec.max);
    return { active: true, path: this.rec.path, bytes: Math.round(secs * 8e6 * 2), seconds: +secs.toFixed(1), max_seconds: this.rec.max };
  }
  async _start(p) {
    if (this.state !== 'idle') this._err('busy', `session.start needs an idle session (state is ${this.state}); stop it first`);
    let data, settings;
    if (p.mode === 'sweep') {
      const span = (p.f_max - p.f_min) / 1e6;
      data = await this._load(span <= 40 ? 'sweepFm' : 'sweepWide'); const h = data.head;
      settings = { mode: 'sweep', f_min: h.f_min, f_max: h.f_max, lna: Math.round((p.lna ?? 16) / 8) * 8, vga: Math.round((p.vga ?? 20) / 2) * 2, amp: !!p.amp, bin_width: h.bin_width, level_unit: 'dBFS' };
      this._log(`demo: replaying ${h.frames} recorded sweep frames ${h.f_min / 1e6}–${h.f_max / 1e6} MHz (the demo ignores the requested range: ${(p.f_min / 1e6).toFixed(1)}–${(p.f_max / 1e6).toFixed(1)} MHz)`);
    } else if (p.mode === 'iq') {
      data = await this._load('iq'); const h = data.head;
      settings = { mode: 'iq', center: h.center, sample_rate: h.sample_rate, lna: h.lna, vga: h.vga, amp: h.amp, baseband_bw: 6e6, fft_size: h.fft_size, avg: h.avg, rbw: h.sample_rate / h.fft_size * 1.5, level_unit: 'dBFS' };
      this._log(`demo: replaying a real HackRF One recording — ${h.source} (requested centre ${(p.center / 1e6).toFixed(3)} MHz ignored)`);
    } else this._err('bad_request', "mode must be 'sweep' or 'iq'");
    this.state = p.mode; this.mode = p.mode; this.settings = settings; this._session();
    const h = data.head, start = p.mode === 'iq' ? h.center - h.sample_rate / 2 : h.f_min, stop = p.mode === 'iq' ? h.center + h.sample_rate / 2 : h.f_max;
    let i = 0;
    this.timer = setInterval(() => {
      const level = data.frames.subarray(i * h.points, (i + 1) * h.points); i = (i + 1) % h.frames; this.seq++;
      this.onFrame?.({ kind: 'spectrum', seq: this.seq, t: Date.now() / 1000, start, stop, points: h.points, bin_width: (stop - start) / h.points, level_unit: 'dBFS', mode: p.mode, settings, dropped: 0, level });
      if (this.rec && (Date.now() - this.rec.started) / 1000 >= this.rec.max) { const d = { active: false, ...this._recStatus() }; this.rec = null; d.active = false; this.onEvent?.('record', d); }
      else if (this.rec && this.seq % 12 === 0) this.onEvent?.('record', this._recStatus());
    }, 1000 / 12);
    return { state: this.state, mode: this.mode, settings };
  }
  _stop(reason) { this._stopTimer(); if (this.rec) { const d = { active: false, ...this._recStatus() }; d.active = false; this.rec = null; this.onEvent?.('record', d); } this.state = 'idle'; this.mode = null; this._session(reason); return { state: 'idle' }; }
}
