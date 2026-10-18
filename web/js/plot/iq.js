// iq.js — views of an IQ snapshot: time domain (I and Q traces) and the
// constellation (density of I/Q points). Input is the HackRF's native
// interleaved int8, as the bridge sends it.
// SPDX-License-Identifier: GPL-2.0-only
import { niceStep } from '../sa.js';
import { cssVar } from './common.js';

/** snap: { iq: Int8Array (interleaved), count, sample_rate, center, t }. window: samples to show (from the end). */
export function renderIqTime(ctx, W, H, snap, window = 2048) {
  const pad = { l: 58, r: 16, t: 14, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  if (!snap) { empty(ctx, W, H, 'No IQ snapshot yet — start an IQ session and click Snapshot (or enable auto).'); return; }
  const n = Math.min(window, snap.count), off = snap.count - n, iq = snap.iq;
  const sx = i => pad.l + i / (n - 1) * pw, sy = v => pad.t + ph / 2 - v / 128 * (ph / 2);
  ctx.strokeStyle = cssVar('--grid'); ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of [-128, -64, 0, 64, 127]) { const y = sy(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke(); ctx.fillText(String(v), pad.l - 8, y); }
  const us = n / snap.sample_rate * 1e6, ts = niceStep(us, Math.max(3, Math.floor(pw / 90)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = 0; t <= us + 1e-9; t += ts) { const x = pad.l + t / us * pw; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.fillText(t >= 1000 ? (t / 1000).toFixed(2) + ' ms' : t.toFixed(0) + ' µs', x, pad.t + ph + 6); }
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph); ctx.lineTo(pad.l + pw, pad.t + ph); ctx.stroke();
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('int8 sample value', 0, 0); ctx.restore();
  const trace = (k, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); for (let i = 0; i < n; i++) { const x = sx(i), y = sy(iq[2 * (off + i) + k]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); };
  trace(1, cssVar('--minhold')); trace(0, cssVar('--trace'));
  let p = 0, clip = 0; for (let i = 0; i < n; i++) { const a = iq[2 * (off + i)], b = iq[2 * (off + i) + 1]; p += a * a + b * b; if (a === 127 || a === -128 || b === 127 || b === -128) clip++; }
  const dbfs = 10 * Math.log10(p / n / (128 * 128) + 1e-12);
  ctx.fillStyle = cssVar('--ink'); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(`${n} samples · ${(n / snap.sample_rate * 1e6).toFixed(0)} µs · mean power ${dbfs.toFixed(1)} dBFS${clip ? ` · ${clip} clipped` : ''}`, pad.l + pw - 6, pad.t + 4);
}

/** Constellation: 2-D histogram of (I, Q) over the whole snapshot, log-scaled. */
export function renderConstellation(ctx, W, H, snap, lut) {
  const pad = { l: 58, r: 16, t: 14, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  if (!snap) { empty(ctx, W, H, 'No IQ snapshot yet.'); return; }
  const size = Math.min(pw, ph), ox = pad.l + (pw - size) / 2, oy = pad.t + (ph - size) / 2, cells = 128;
  const hist = new Uint32Array(cells * cells); let mx = 0;
  for (let i = 0; i < snap.count; i++) { const a = (snap.iq[2 * i] + 128) >> 1, b = (127 - snap.iq[2 * i + 1]) >> 1; const k = b * cells + a; if (++hist[k] > mx) mx = hist[k]; }
  const cs = size / cells, lmx = Math.log(mx + 1);
  ctx.fillStyle = lut[0]; ctx.fillRect(ox, oy, size, size);
  for (let k = 0; k < hist.length; k++) { if (!hist[k]) continue; const t = Math.log(hist[k] + 1) / lmx; ctx.fillStyle = lut[Math.min(255, Math.round(t * 255))]; ctx.fillRect(ox + (k % cells) * cs, oy + Math.floor(k / cells) * cs, cs + 0.5, cs + 0.5); }
  ctx.strokeStyle = cssVar('--axis'); ctx.strokeRect(ox, oy, size, size);
  ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(ox + size / 2, oy); ctx.lineTo(ox + size / 2, oy + size); ctx.moveTo(ox, oy + size / 2); ctx.lineTo(ox + size, oy + size / 2); ctx.stroke(); ctx.setLineDash([]);
  for (const r of [32, 64, 96, 127]) { ctx.beginPath(); ctx.arc(ox + size / 2, oy + size / 2, r / 128 * size / 2, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('I', ox + size - 8, oy + size / 2 + 4); ctx.fillText('Q', ox + size / 2 + 8, oy + 2);
  ctx.textAlign = 'center'; ctx.fillStyle = cssVar('--ink-2'); ctx.fillText(`${snap.count} samples · rings at |x| = 32, 64, 96, 127 · colour = log density`, pad.l + pw / 2, pad.t + ph + 6);
}

function empty(ctx, W, H, text) { ctx.font = '13px ' + cssVar('--font'); ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, W / 2, H / 2); }
