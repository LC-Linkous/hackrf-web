// waterfall.js — rolling level history under the live trace.
// SPDX-License-Identifier: GPL-2.0-only
import { clamp, niceStep, fmtAxis, nearestIndex } from '../sa.js';
import { drawMarkerGlyph, cssVar } from './common.js';

export const WATERFALL_ROWS = 200;

/** history: array of Float32Array rows (newest first). lut: 256 colours. range: [floorDbm, refDbm]. */
export function renderWaterfall(ctx, W, H, sweep, history, markers, hover, lut, range, unit = 'dBFS') {
  const [y0, y1] = range;
  const pad = { l: 58, r: 16, t: 14, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const traceH = Math.round(ph * 0.3), wfTop = pad.t + traceH + 10, wfH = ph - traceH - 10;
  const sx = f => pad.l + (f - sweep.start) / (sweep.stop - sweep.start) * pw;
  const sy = y => pad.t + traceH - (clamp(y, y0, y1) - y0) / (y1 - y0) * traceH;
  ctx.font = '12px ' + cssVar('--font');
  ctx.strokeStyle = cssVar('--axis'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + traceH); ctx.lineTo(pad.l + pw, pad.t + traceH); ctx.stroke();
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(String(y1), pad.l - 8, sy(y1)); ctx.fillText(String(y0), pad.l - 8, sy(y0)); ctx.fillText(unit, pad.l - 8, sy((y0 + y1) / 2));
  ctx.strokeStyle = cssVar('--trace'); ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < sweep.pts; i++) { const x = sx(sweep.f[i]), y = sy(sweep.dbm[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();

  const rh = wfH / Math.max(40, Math.min(WATERFALL_ROWS, history.length));
  for (let r = 0; r < history.length; r++) {
    const row = history[r], y = wfTop + r * rh;
    for (let i = 0; i < row.length; i++) {
      const t = clamp((row[i] - y0) / (y1 - y0), 0, 1);                 // floor → 0, ref → 1
      ctx.fillStyle = lut[Math.round(t * 255)];
      const x0 = pad.l + i / row.length * pw, x1 = pad.l + (i + 1) / row.length * pw;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 + 0.5), rh + 0.5);
    }
  }
  ctx.strokeStyle = cssVar('--axis'); ctx.strokeRect(pad.l, wfTop, pw, wfH);
  ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const fs = niceStep(sweep.stop - sweep.start, Math.max(3, Math.floor(pw / 90)));
  for (let f = Math.ceil(sweep.start / fs) * fs; f <= sweep.stop + 1; f += fs) ctx.fillText(fmtAxis(f), sx(f), wfTop + wfH + 6);
  ctx.save(); ctx.translate(14, wfTop + wfH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`${history.length} sweeps, newest at top`, 0, 0); ctx.restore();
  markers.forEach((mf, k) => { const i = nearestIndex(sweep.f, mf); drawMarkerGlyph(ctx, sx(sweep.f[i]), sy(sweep.dbm[i]), k + 1); });
  return { sx, sy, pad, pw, ph: traceH, fx: x => sweep.start + (x - pad.l) / pw * (sweep.stop - sweep.start), yOf: i => sweep.dbm[i] };
}
