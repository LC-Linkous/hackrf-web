// sa.js — pure spectrum-analyzer math and formatting. No DOM, no state.
// SPDX-License-Identifier: GPL-2.0-only

export const clamp = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));

export function fmtHz(f, digits = 3) {
  if (!Number.isFinite(f)) return '—';
  if (f >= 1e9) return (f / 1e9).toFixed(digits) + ' GHz';
  if (f >= 1e6) return (f / 1e6).toFixed(digits) + ' MHz';
  if (f >= 1e3) return (f / 1e3).toFixed(1) + ' kHz';
  return f.toFixed(0) + ' Hz';
}
/** Short axis label: drop trailing zeros ("1.5 GHz", "200 MHz"). */
export const fmtAxis = f => fmtHz(f).replace(/\.?0+ (\w)/, ' $1');
export const fmtDbm = (v, unit = "dBFS") => (Number.isFinite(v) ? v.toFixed(1) : "—") + " " + unit;

export function nearestIndex(freqs, fHz) {
  let b = 0, bd = Infinity;
  for (let i = 0; i < freqs.length; i++) { const d = Math.abs(freqs[i] - fHz); if (d < bd) { bd = d; b = i; } }
  return b;
}
export function niceStep(range, target) {
  const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** Index of the highest level. */
export function peakIndex(dbm) { let b = 0, bv = -Infinity; for (let i = 0; i < dbm.length; i++) if (dbm[i] > bv) { bv = dbm[i]; b = i; } return b; }

/**
 * Local maxima, highest first, at least minSep points apart and at least
 * minAbove dB over the sweep's median (a cheap noise-floor estimate).
 */
export function findPeaks(dbm, { count = 4, minSep = 5, minAbove = 10 } = {}) {
  const n = dbm.length; if (n < 3) return [];
  const sorted = Float32Array.from(dbm).sort(); const floor = sorted[n >> 1];
  const cand = [];
  for (let i = 1; i < n - 1; i++) if (dbm[i] >= dbm[i - 1] && dbm[i] > dbm[i + 1] && dbm[i] - floor >= minAbove) cand.push(i);
  cand.sort((a, b) => dbm[b] - dbm[a]);
  const out = [];
  for (const i of cand) { if (out.every(j => Math.abs(j - i) >= minSep)) out.push(i); if (out.length >= count) break; }
  return out;
}

/** Channel power over [i0, i1]: sum of mW per point (no bandwidth normalisation). */
export function channelPowerDbm(dbm, i0, i1) {
  let mw = 0; for (let i = i0; i <= i1; i++) mw += Math.pow(10, dbm[i] / 10);
  return 10 * Math.log10(mw);
}

/** Running combine helpers for page-side max/min hold and averaging. */
export const holdMax = (acc, cur) => { for (let i = 0; i < cur.length; i++) if (cur[i] > acc[i]) acc[i] = cur[i]; return acc; };
export const holdMin = (acc, cur) => { for (let i = 0; i < cur.length; i++) if (cur[i] < acc[i]) acc[i] = cur[i]; return acc; };
/** Exponential average in the power domain, alpha = 1/N. */
export const averageInto = (acc, cur, n) => { const a = 1 / n; for (let i = 0; i < cur.length; i++) { const p = Math.pow(10, acc[i] / 10) * (1 - a) + Math.pow(10, cur[i] / 10) * a; acc[i] = 10 * Math.log10(p); } return acc; };

/** Median of the sweep — a cheap noise-floor estimate (what findPeaks uses). */
export function noiseFloor(dbm) { const s = Float32Array.from(dbm).sort(); return s[s.length >> 1]; }

/** Running median / mean, edge-padded, k odd. From tsapython's filtering_scan_artifacts.py. */
export function medianFilter(x, k = 5) {
  const n = x.length, h = k >> 1, out = new Float32Array(n), w = new Float32Array(k);
  for (let i = 0; i < n; i++) { for (let j = 0; j < k; j++) w[j] = x[Math.min(n - 1, Math.max(0, i + j - h))]; out[i] = Float32Array.from(w).sort()[h]; }
  return out;
}
export function meanFilter(x, k = 5) {
  const n = x.length, h = k >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -h; j <= h; j++) s += x[Math.min(n - 1, Math.max(0, i + j))]; out[i] = s / k; }
  return out;
}

/**
 * Parabolic interpolation of the peak at index i: fits a parabola through
 * (i−1, i, i+1) and returns { f, dbm } of its apex. Standard SA trick for
 * reading a carrier that falls between two bins.
 */
export function interpolatePeak(f, dbm, i) {
  if (i <= 0 || i >= dbm.length - 1) return { f: f[i], dbm: dbm[i] };
  const a = dbm[i - 1], b = dbm[i], c = dbm[i + 1], d = a - 2 * b + c;
  if (d >= 0) return { f: f[i], dbm: b };
  const p = 0.5 * (a - c) / d;                       // −0.5 … 0.5 bins
  return { f: f[i] + p * (f[i + 1] - f[i]), dbm: b - 0.25 * (a - c) * p };
}

/** −3 dB bandwidth of the peak at index i, with linear interpolation at the edges. Hz, or null if it runs off the sweep. */
export function bandwidth3dB(f, dbm, i) {
  const target = dbm[i] - 3; let lo = i, hi = i;
  while (lo > 0 && dbm[lo] > target) lo--; while (hi < dbm.length - 1 && dbm[hi] > target) hi++;
  if (dbm[lo] > target || dbm[hi] > target) return null;
  const edge = (j, k) => f[j] + (target - dbm[j]) / (dbm[k] - dbm[j]) * (f[k] - f[j]);
  return edge(hi - 1, hi) - edge(lo + 1, lo);
}
