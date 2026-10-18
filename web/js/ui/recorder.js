// recorder.js — timestamped logging of sweeps, with CSV export.
// Sweep-mode frames only; IQ recordings are written by the bridge as SigMF.
// SPDX-License-Identifier: GPL-2.0-only

const iso = t => new Date(t).toISOString();

export function createRecorder() {
  const rec = { on: false, sweeps: [], startedAt: null, onChange: null };

  rec.start = () => { rec.on = true; rec.startedAt = Date.now(); rec.onChange?.(); };
  rec.stop = () => { rec.on = false; rec.onChange?.(); };
  rec.clear = () => { rec.sweeps = []; rec.startedAt = null; rec.onChange?.(); };

  /** Call with every accepted sweep. Stores a copy. */
  rec.addSweep = sw => { if (!rec.on) return; rec.sweeps.push({ t: sw.t || Date.now(), start: sw.start, stop: sw.stop, pts: sw.pts, method: sw.method, f: sw.f.slice(), dbm: sw.dbm.slice() }); rec.onChange?.(); };

  /** Rough memory estimate for the status line. */
  rec.bytes = () => rec.sweeps.reduce((a, s) => a + s.pts * 12, 0);

  // ---- exports ---------------------------------------------------------------
  /** Long format: one row per (sweep, point). Easy to load in pandas / Excel. */
  rec.sweepsCsv = () => {
    const rows = ['timestamp_iso,sweep_index,sweep_t_ms,mode,freq_hz,level_dbfs'];
    rec.sweeps.forEach((s, k) => { const ts = iso(s.t); for (let i = 0; i < s.pts; i++) rows.push(`${ts},${k},${s.t},${s.method},${s.f[i]},${s.dbm[i].toFixed(2)}`); });
    return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  };

  /**
   * Waterfall matrix: one row per sweep, one column per frequency, level in dBm.
   * Only sweeps with the same frequency grid as the first are included (the
   * others are reported in the first comment line), so the matrix is rectangular.
   */
  rec.waterfallCsv = () => {
    if (!rec.sweeps.length) return new Blob([''], { type: 'text/csv' });
    const ref = rec.sweeps[0];
    const same = s => s.pts === ref.pts && s.start === ref.start && s.stop === ref.stop;
    const kept = rec.sweeps.filter(same), skipped = rec.sweeps.length - kept.length;
    const rows = [`# hackrf-web waterfall: level dBFS, ${kept.length} sweeps, ${ref.pts} points, ${ref.start} – ${ref.stop} Hz${skipped ? `; ${skipped} sweep(s) with a different grid omitted` : ''}`];
    rows.push('timestamp_iso,sweep_t_ms,' + Array.from(ref.f, f => f).join(','));
    for (const s of kept) rows.push(`${iso(s.t)},${s.t},${Array.from(s.dbm, v => v.toFixed(2)).join(',')}`);
    return new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  };

  /** Everything, as JSON (sweeps as plain arrays). */
  rec.jsonBlob = meta => new Blob([JSON.stringify({ tool: 'hackrf-web', kind: 'recording', ...meta, startedAt: rec.startedAt && iso(rec.startedAt), sweeps: rec.sweeps.map(s => ({ ...s, f: Array.from(s.f), dbm: Array.from(s.dbm) })) })], { type: 'application/json' });

  return rec;
}
