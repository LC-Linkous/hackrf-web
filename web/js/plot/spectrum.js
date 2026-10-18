// spectrum.js — level (dBFS, or dBm with a calibration) vs frequency, with max/min hold, average, held
// trace and a loaded overlay.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp, niceStep, fmtAxis, nearestIndex } from '../sa.js';
import { drawMarkerGlyph, cssVar } from './common.js';

/**
 * sweep: { f, dbm, pts, start, stop }
 * layers: { max?, min?, avg? } Float32Array of sweep.pts (page-side holds)
 * range: [floorDbm, refDbm]
 * Returns a geometry object for hit-testing.
 */
export function renderSpectrum(ctx, W, H, sweep, layers, held, markers, hover, overlay, range, unit = 'dBFS') {
  const pad = { l: 58, r: 16, t: 14, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const [y0, y1] = range;
  const sx = f => pad.l + (f - sweep.start) / (sweep.stop - sweep.start) * pw;
  const sy = y => pad.t + ph - (clamp(y, y0, y1) - y0) / (y1 - y0) * ph;
  const geom = { sx, sy, pad, pw, ph, fx: x => sweep.start + (x - pad.l) / pw * (sweep.stop - sweep.start), yOf: i => sweep.dbm[i] };

  ctx.font = '12px ' + cssVar('--font'); ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--grid'); ctx.fillStyle = cssVar('--ink-2');
  const fs = niceStep(sweep.stop - sweep.start, Math.max(3, Math.floor(pw / 90)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = Math.ceil(sweep.start / fs) * fs; f <= sweep.stop + 1; f += fs) { const x = sx(f); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.fillText(fmtAxis(f), x, pad.t + ph + 6); }
  const ys = niceStep(y1 - y0, Math.max(3, Math.floor(ph / 45)));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let y = Math.ceil(y0 / ys) * ys; y <= y1 + 1e-9; y += ys) { const yy = sy(y); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke(); ctx.fillText(+y.toFixed(1), pad.l - 8, yy); }
  ctx.strokeStyle = cssVar('--axis'); ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph); ctx.lineTo(pad.l + pw, pad.t + ph); ctx.stroke();
  ctx.save(); ctx.translate(14, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`Level (${unit})`, 0, 0); ctx.restore();

  // an overlay may cover a different span: draw only the part inside the axis
  const traceAny = (f, v, col, dash, width = 2) => {
    ctx.strokeStyle = col; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); let pen = false;
    for (let i = 0; i < f.length; i++) { if (f[i] < sweep.start || f[i] > sweep.stop) { pen = false; continue; } const x = sx(f[i]), y = sy(v[i]); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; }
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (overlay) traceAny(overlay.f, overlay.dbm, cssVar('--overlay'), [2, 3]);
  if (held && held.start === sweep.start && held.stop === sweep.stop) traceAny(held.f, held.dbm, cssVar('--held'), [5, 4]);
  if (layers.min) traceAny(sweep.f, layers.min, cssVar('--minhold'), [], 1.5);
  if (layers.max) traceAny(sweep.f, layers.max, cssVar('--maxhold'), [], 1.5);
  if (layers.avg) traceAny(sweep.f, layers.avg, cssVar('--avg'), [], 2);
  traceAny(sweep.f, sweep.dbm, cssVar('--trace'), [], layers.avg ? 1 : 2);

  markers.forEach((mf, k) => { const i = nearestIndex(sweep.f, mf); drawMarkerGlyph(ctx, sx(sweep.f[i]), sy(sweep.dbm[i]), k + 1); });
  if (hover != null) { const x = sx(sweep.f[hover]); ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke(); ctx.setLineDash([]); }
  return geom;
}
