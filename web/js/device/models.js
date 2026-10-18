// models.js — the HackRF One operating envelope, from hackrfpy/constants.py.
// SPDX-License-Identifier: GPL-2.0-only
//
// One model only (the HackRF One); the page checks requests against these
// before they reach the bridge, and hackrfpy checks them again.
export const LIMITS = {
  name: 'HackRF One',
  freqMin: 1e6, freqMax: 6e9,
  srMin: 2e6, srMax: 20e6, srWarnBelow: 8e6,
  lna: [0, 40, 8],        // IF gain, 8 dB steps
  vga: [0, 62, 2],        // baseband gain, 2 dB steps
  txvgaMax: 47, ampDb: 14,
  fftSizes: [256, 512, 1024, 2048, 4096, 8192],
  sampleRates: [2e6, 4e6, 8e6, 10e6, 12.5e6, 16e6, 20e6],
  basebandBw: [1.75e6, 2.5e6, 3.5e6, 5e6, 5.5e6, 6e6, 7e6, 8e6, 9e6, 10e6, 12e6, 14e6, 15e6, 20e6, 24e6, 28e6],
};
/** Snap a gain to the device's steps, the way hackrfpy's _snap_gain does. */
export function snapGain(which, v) { const [lo, hi, step] = LIMITS[which]; return Math.min(hi, Math.max(lo, Math.round(v / step) * step)); }
/** hackrfpy's band presets, for the Sweep section's quick picks. */
export const PRESETS = [
  { key: 'fm', name: 'FM broadcast', f_min: 88e6, f_max: 108e6, center: 98.1e6, sample_rate: 10e6 },
  { key: 'airband', name: 'Airband', f_min: 118e6, f_max: 137e6, center: 127.5e6, sample_rate: 8e6 },
  { key: 'ism433', name: 'ISM 433', f_min: 430e6, f_max: 440e6, center: 433.92e6, sample_rate: 8e6 },
  { key: 'ism868', name: 'ISM 868 / 915', f_min: 860e6, f_max: 930e6, center: 915e6, sample_rate: 20e6 },
  { key: 'wifi24', name: '2.4 GHz', f_min: 2400e6, f_max: 2500e6, center: 2437e6, sample_rate: 20e6 },
  { key: 'wide', name: '1 MHz – 1 GHz', f_min: 1e6, f_max: 1000e6, center: 500e6, sample_rate: 20e6 },
];
