// settings.js — persisted user settings (localStorage) and the Settings panel.
// SPDX-License-Identifier: GPL-2.0-only
import { PALETTES, DEFAULT_PALETTE, cssGradient } from '../plot/palettes.js';

const KEY = 'hackrf-web.settings';
const DEFAULTS = {
  theme: 'dark', traces: 'instrument', palette: DEFAULT_PALETTE,
  refDbm: 0, floorDbm: -100,     // level axis in dBFS
  maxMarkers: 6, avgCount: 8,
  autoSnapshot: true,            // ask for an IQ snapshot every second while an IQ session runs
  snapshotCount: 16384,
  rawFrames: false,              // log every frame header in the console
  bridgeAddr: '127.0.0.1:8765',  // remembered bridge address (token is never stored)
};

export const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
settings.maxMarkers = DEFAULTS.maxMarkers;

export function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} }
export function applyTheme() { const r = document.documentElement; r.setAttribute('data-theme', settings.theme); r.setAttribute('data-traces', settings.traces); }
export const levelRange = () => [Math.min(settings.floorDbm, settings.refDbm - 10), settings.refDbm];

export function initSettingsPanel(form, onChange) {
  const sel = form.querySelector('[name=palette]');
  sel.innerHTML = Object.entries(PALETTES).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  const swatch = form.querySelector('.palette-swatch');
  const refresh = () => {
    form.querySelector(`[name=theme][value=${settings.theme}]`).checked = true;
    form.querySelector(`[name=traces][value=${settings.traces}]`).checked = true;
    sel.value = settings.palette; swatch.style.background = cssGradient(settings.palette);
    form.querySelector('[name=refDbm]').value = String(settings.refDbm);
    form.querySelector('[name=floorDbm]').value = String(settings.floorDbm);
    form.querySelector('[name=avgCount]').value = settings.avgCount;
    form.querySelector('[name=snapshotCount]').value = String(settings.snapshotCount);
    for (const k of ['autoSnapshot', 'rawFrames']) form.querySelector(`[name=${k}]`).checked = settings[k];
  };
  refresh();
  form.addEventListener('change', e => {
    const el = e.target, n = el.name; if (!n) return;
    if (el.type === 'checkbox') settings[n] = el.checked;
    else if (['refDbm', 'floorDbm', 'snapshotCount'].includes(n)) settings[n] = parseInt(el.value, 10);
    else if (n === 'avgCount') settings[n] = Math.min(64, Math.max(2, parseInt(el.value, 10) || 8));
    else settings[n] = el.value;
    save(); applyTheme(); swatch.style.background = cssGradient(settings.palette); onChange(n);
  });
  form.addEventListener('submit', e => e.preventDefault());
}
