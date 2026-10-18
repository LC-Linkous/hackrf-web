// hackrf.js — the HackRF API as the page sees it. Method names follow hackrfpy
// where the meaning is the same (preflight, detect, sweep, open_receiver →
// startIq, transmit_cw → txTone); everything goes through one link (bridge
// or demo) and nothing here knows about hackrf-tools.
// SPDX-License-Identifier: GPL-2.0-only
import { LIMITS, snapGain } from './models.js';

export class HackRF {
  constructor(link) {
    this.link = link;
    this.hello = link.hello || null;
    this.state = 'idle'; this.mode = null; this.settings = {};
    this.preflightReport = null;
  }
  get env() { return LIMITS; }
  get allowTx() { return !!(this.hello && this.hello.allow_tx); }
  get label() { const b = this.preflightReport?.boards?.[0]; return b ? `${b.name || 'HackRF'} · fw ${b.firmware || b.firmware_version || '?'} · ${(b.serial || '').slice(-8)}` : (this.preflightReport ? 'no board' : 'preflight pending'); }

  /** Adopt whatever the bridge is doing; run preflight only when it is idle (preflight needs the device). */
  async identify() {
    this.hello = this.link.hello;
    const st = await this.link.call('session.status');
    this.state = st.state; this.mode = st.mode; this.settings = st.settings || {};
    this.preflightReport = st.state === 'idle' ? await this.link.call('device.preflight') : null;
    return { status: st, preflight: this.preflightReport };
  }
  preflight() { return this.link.call('device.preflight'); }
  detect() { return this.link.call('device.detect'); }
  info() { return this.link.call('device.info'); }
  status() { return this.link.call('session.status'); }

  /** hackrf_sweep: f_min/f_max in Hz; bin_width Hz or null for the tool's default. */
  startSweep({ f_min, f_max, bin_width = null, lna = 16, vga = 20, amp = false }) {
    f_min = Math.max(LIMITS.freqMin, Math.min(LIMITS.freqMax, f_min)); f_max = Math.max(LIMITS.freqMin, Math.min(LIMITS.freqMax, f_max));
    return this.link.call('session.start', { mode: 'sweep', f_min, f_max, bin_width, lna: snapGain('lna', lna), vga: snapGain('vga', vga), amp: !!amp });
  }
  /** hackrf_transfer -r -: centre/sample_rate in Hz; the bridge does the FFT. */
  startIq({ center, sample_rate, fft_size = 2048, avg = 4, lna = 16, vga = 20, amp = false }) {
    center = Math.max(LIMITS.freqMin, Math.min(LIMITS.freqMax, center)); sample_rate = Math.max(LIMITS.srMin, Math.min(LIMITS.srMax, sample_rate));
    return this.link.call('session.start', { mode: 'iq', center, sample_rate, fft_size, avg, lna: snapGain('lna', lna), vga: snapGain('vga', vga), amp: !!amp });
  }
  stop() { return this.link.call('session.stop'); }
  kill() { return this.link.call('session.kill'); }
  /** Ask for the latest IQ block; it arrives as an 'iq' frame on link.onFrame. */
  snapshot(count = 16384, quiet = false) { return this.link.call('iq.snapshot', { count }, { quiet }); }
  recordStart(max_seconds) { return this.link.call('record.start', { max_seconds }); }
  recordStop() { return this.link.call('record.stop'); }
  recordStatus() { return this.link.call('record.status'); }
  /** transmit_cw. The bridge enforces --allow-tx, confirm and the duration cap; the page asks the user first. */
  txTone({ freq, sample_rate = 2e6, txvga = 0, amp = false, amplitude = 64, duration }) { return this.link.call('tx.tone', { freq, sample_rate, txvga: Math.max(0, Math.min(LIMITS.txvgaMax, txvga)), amp: !!amp, amplitude, duration, confirm: true }); }
  txStop() { return this.link.call('tx.stop'); }
  raw(method, params) { return this.link.call(method, params); }
}

/** Turn a spectrum frame into the sweep shape the plots use: { start, stop, pts, f, dbm }. */
export function frameToSweep(fr) {
  const pts = fr.points, f = new Float64Array(pts), bw = (fr.stop - fr.start) / pts;
  for (let i = 0; i < pts; i++) f[i] = fr.start + bw * (i + 0.5);
  return { start: fr.start, stop: fr.stop, pts, f, dbm: fr.level, t: fr.t * 1000, seq: fr.seq, mode: fr.mode, unit: fr.level_unit || 'dBFS', settings: fr.settings, dropped: fr.dropped || 0, ms: 0, method: fr.mode };
}
