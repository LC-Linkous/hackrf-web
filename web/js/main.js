// main.js — application state and wiring. Everything else is a module.
// SPDX-License-Identifier: GPL-2.0-only
import { HackRF, frameToSweep } from './device/hackrf.js';
import { BridgeLink } from './device/bridge-link.js';
import { DemoLink } from './device/demo-link.js';
import { LIMITS, PRESETS, snapGain } from './device/models.js';
import { fmtHz, nearestIndex, peakIndex, findPeaks, holdMax, holdMin, averageInto, noiseFloor, interpolatePeak, bandwidth3dB, channelPowerDbm } from './sa.js';
import { renderSpectrum } from './plot/spectrum.js';
import { renderWaterfall, WATERFALL_ROWS } from './plot/waterfall.js';
import { renderIqTime, renderConstellation } from './plot/iq.js';
import { buildLut, cssGradient } from './plot/palettes.js';
import { cssVar } from './plot/common.js';
import { settings, applyTheme, initSettingsPanel, save as saveSettings, levelRange } from './ui/settings.js';
import { initConsole } from './ui/console.js';
import { initSidebar } from './ui/sidebar.js';
import { createPanes } from './ui/panes.js';
import { download, stamp, csvBlob, canvasPng } from './ui/export.js';
import { createRecorder } from './ui/recorder.js';
import { initAbout } from './ui/about.js';

const APP_VERSION = '0.1.0';
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- state
const state = {
  rf: null, demo: false,
  sweep: null, held: null, history: [], markers: [],
  layers: { max: null, min: null, avg: null }, maxOn: false, minOn: false, avgOn: false, avgN: 0,
  session: { state: 'idle', mode: null, settings: {} }, busy: false,
  snap: null, snapTimer: null, lastHeaders: [], preflight: null, hello: null,
  frames: 0, lastFrameT: 0, fpsWin: [],
  lut: buildLut(settings.palette),
};
const chart = { dirty: true, hover: null, geoms: [] };

applyTheme();
const sidebar = initSidebar($('sidebar'));
const con = initConsole({ log: $('log'), form: $('sendForm'), input: $('sendInput'), handle: $('conHandle'), drawer: $('console'), clearBtn: $('conClear'), copyBtn: $('conCopy'), dlBtn: $('conDl'), dlMode: $('conDlMode') }, sendManual);
const recorder = createRecorder();
const about = initAbout($('about'), $('aboutLink'), [$('plotArea'), $('markersPanel')], { version: APP_VERSION, onToggle() { chart.dirty = true; } });
const VIEWS = { spectrum: 'Spectrum', waterfall: 'Waterfall', iqtime: 'IQ time', constellation: 'Constellation' };
const panes = createPanes($('panes'), VIEWS, () => { wirePanes(); buildLegend(); chart.dirty = true; });

// ---------------------------------------------------------------- status / enable
function setStatus(text, cls) { $('statusText').textContent = text; $('status').className = 'status ' + (cls || ''); }
function setEnabled(on) {
  ['preflightBtn', 'detectBtn', 'sweepBtn', 'iqBtn', 'diagBtn'].forEach(id => $(id).disabled = !on);
  con.setEnabled(on);
  $('demoBtn').disabled = on && !state.demo;
  $('demoBtn').classList.toggle('demo-active', on && state.demo); $('demoBtn').setAttribute('aria-pressed', String(on && state.demo));
  $('demoBtn').textContent = on && state.demo ? 'Demo mode (click to leave)' : 'Try without hardware';
  $('connectBtn').textContent = on ? 'Disconnect' : 'Connect to bridge';
  $('sessBadge').hidden = !on;
  refreshSessionUi();
}
function refreshSessionUi() {
  const s = state.session, on = !!state.rf, run = s.state !== 'idle';
  $('sessBadge').textContent = run ? `${s.state}${s.mode === 'iq' && s.settings.center ? ' · ' + fmtHz(s.settings.center) : s.mode === 'sweep' && s.settings.f_min != null ? ` · ${fmtHz(s.settings.f_min)} – ${fmtHz(s.settings.f_max)}` : ''}` : 'idle';
  $('sessBadge').className = 'badge ' + (s.state === 'tx' ? 'warn' : run ? 'ok' : '');
  const sweepRun = s.state === 'sweep', iqRun = s.state === 'iq';
  $('sweepBtn').textContent = sweepRun ? 'Stop sweep' : 'Start sweep'; $('sweepBtn').classList.toggle('running', sweepRun); $('sweepBtn').setAttribute('aria-pressed', String(sweepRun)); $('sweepBtn').disabled = !on || (run && !sweepRun);
  $('iqBtn').textContent = iqRun ? 'Stop IQ' : 'Start IQ'; $('iqBtn').classList.toggle('running', iqRun); $('iqBtn').setAttribute('aria-pressed', String(iqRun)); $('iqBtn').disabled = !on || (run && !iqRun);
  $('snapBtn').disabled = !iqRun; $('recIqBtn').disabled = !iqRun; $('tuneBtn').disabled = !on || !state.markers.length;
  ['preflightBtn', 'detectBtn'].forEach(id => $(id).disabled = !on || run);
  const txOk = on && state.rf.allowTx; $('txLocked').hidden = txOk; $('txBtn').disabled = !txOk || run;
  $('txBadge').hidden = s.state !== 'tx';
  $('gainsUsed').textContent = run && s.settings.lna != null ? `In use: LNA ${s.settings.lna} dB, VGA ${s.settings.vga} dB, amp ${s.settings.amp ? 'on' : 'off'}` : '';
  if (iqRun && settings.autoSnapshot && !state.snapTimer) state.snapTimer = setInterval(() => takeSnapshot(true), 1000);
  if (!iqRun && state.snapTimer) { clearInterval(state.snapTimer); state.snapTimer = null; }
}

// ---------------------------------------------------------------- connect
function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('bridge')) { $('bridgeAddr').value = h.get('bridge'); settings.bridgeAddr = h.get('bridge'); saveSettings(); }
  if (h.get('token')) { $('bridgeToken').value = h.get('token'); $('bridgeHint').textContent = 'Token read from the URL the bridge opened. It is not stored; reload the page from the bridge if it changes.'; }
  return !!h.get('token');
}
async function connect(demo) {
  if (state.rf) return;
  const link = demo ? new DemoLink() : new BridgeLink();
  link.onTx = t => con.tx(t); link.onRx = t => con.dim(t);
  link.onEvent = onEvent; link.onFrame = onFrame;
  link.onClose = () => { con.err('bridge connection closed'); disconnect(true); };
  const rf = new HackRF(link);
  const addr = $('bridgeAddr').value.trim() || '127.0.0.1:8765', token = $('bridgeToken').value.trim();
  if (!demo && !token) { setStatus('Paste the bridge token (printed by hackrf-web) or open the page from the bridge', 'err'); sidebar.open('bridge'); $('bridgeToken').focus(); return; }
  setStatus(demo ? 'Loading recorded frames…' : `Connecting to ${addr}…`, '');
  try {
    state.hello = await link.open(addr, token);
    state.rf = rf; state.demo = demo;
    if (demo) con.dim('demo: no bridge — replaying recorded frames (a real HackRF One FM recording for IQ mode, the bridge\'s fake device for sweeps)');
    else { con.dim(`bridge ${state.hello.version}${state.hello.fake ? ' (fake device)' : ''} · transmit ${state.hello.allow_tx ? 'ENABLED' : 'locked'}`); if (state.hello.page_version_expected && !APP_VERSION.startsWith(state.hello.page_version_expected)) con.err(`bridge expects page ${state.hello.page_version_expected}.x, this page is ${APP_VERSION} — pip install -U hackrf-web, or use the bridge's own copy at http://${addr}/`); }
    const id = await rf.identify();
    state.session = { state: id.status.state, mode: id.status.mode, settings: id.status.settings || {} };
    if (id.preflight) { state.preflight = id.preflight; showPreflight(state.preflight); }
    else { con.dim(`bridge already has a ${id.status.state} session running — adopted it; preflight runs when it is idle`); if (id.status.recording?.active) refreshIqRec(id.status.recording); }
    const probs = state.preflight?.problems || [];
    setStatus(`${demo ? 'Demo' : state.hello.fake ? 'Bridge (fake device)' : 'Connected'} · ${rf.label}${probs.length ? ` · ${probs.length} preflight problem${probs.length > 1 ? 's' : ''}` : ''}`, probs.length ? 'err' : demo ? 'demo' : 'ok');
    if (!demo && !state.hello.fake) { settings.bridgeAddr = addr; saveSettings(); }
    setEnabled(true); chart.dirty = true;
  } catch (e) {
    con.err('connect failed: ' + e.message); setStatus('Connection failed — ' + e.message, 'err');
    try { link.close(); } catch {}
    if (!demo) sidebar.open('bridge');
  }
}
async function disconnect(silent) {
  if (!state.rf) return;
  const rf = state.rf;
  try { if (!silent && state.session.state !== 'idle') await rf.stop(); } catch {}
  rf.link.close(); state.rf = null; state.demo = false; state.hello = null;
  state.session = { state: 'idle', mode: null, settings: {} };
  setEnabled(false); setStatus('Not connected', ''); chart.dirty = true;
}
function showPreflight(p) {
  const out = $('preflightOut'); out.hidden = false;
  const tools = Object.entries(p.tools || {}).map(([k, v]) => `${v ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${k}${v && v !== '(fake)' && v !== '(demo)' ? ' — ' + v : v ? ' ' + v : ' — not found'}`).join('\n');
  const boards = (p.boards || []).map(b => `<span class="ok">✓</span> ${b.name || 'board'} · serial ${b.serial || '?'} · fw ${b.firmware || b.firmware_version || '?'}`).join('\n') || '<span class="bad">✗</span> no board detected';
  const probs = (p.problems || []).map(x => `<span class="bad">!</span> ${x}`).join('\n');
  out.innerHTML = `${tools}\n${boards}\ntools ${p.tool_version || '?'} · disk free ${p.disk_free_bytes != null ? (p.disk_free_bytes / 1e9).toFixed(1) + ' GB' : '?'} · recordings → ${p.bridge?.record_dir || '?'}${probs ? '\n' + probs : '\n<span class="ok">no problems</span>'}`;
}

// ---------------------------------------------------------------- events / frames
function onEvent(name, data) {
  if (name === 'session') { state.session = { state: data.state, mode: data.mode, settings: data.settings || {} }; if (data.reason && data.state === 'idle') con.dim(`session idle (${data.reason})`); refreshSessionUi(); chart.dirty = true; }
  else if (name === 'log') { (data.level === 'error' ? con.err : data.level === 'warn' ? con.err : con.dim)(data.text); }
  else if (name === 'record') { refreshIqRec(data); }
  else if (name === 'device') { con.err(`device ${data.status}${data.stderr ? ': ' + data.stderr : ''}`); }
  else if (name === 'tx') { $('txStatus').textContent = data.on ? `ON AIR — ${fmtHz(data.freq)} · ${data.seconds_left} s left` : 'transmit ended'; }
  else if (name === 'hello') { /* handled in connect */ }
}
function onFrame(fr) {
  if (settings.rawFrames) con.dim(`frame ${fr.kind} #${fr.seq} ${fr.kind === 'spectrum' ? `${fr.points} pts ${fmtHz(fr.start)}–${fmtHz(fr.stop)}` : `${fr.count} samples`}`);
  state.lastHeaders.push({ ...fr, level: undefined, iq: undefined, settings: undefined }); if (state.lastHeaders.length > 20) state.lastHeaders.shift();
  if (fr.kind === 'iq') { state.snap = fr; $('snapStat').textContent = `${fr.count} samples @ ${fmtHz(fr.sample_rate)} · ${new Date(fr.t * 1000).toLocaleTimeString()}`; $('iqCsvBtn').disabled = false; chart.dirty = true; return; }
  if (fr.kind !== 'spectrum') return;
  acceptSweep(frameToSweep(fr));
  state.frames++; const now = performance.now(); state.fpsWin.push(now); state.fpsWin = state.fpsWin.filter(t => now - t < 2000);
  const fps = (state.fpsWin.length / 2).toFixed(1);
  if (fr.mode === 'sweep') { $('sweepStat').textContent = `#${fr.seq} · ${fps} fps · ${fr.points} bins${fr.dropped ? ` · ${fr.dropped} not sent` : ''}`; $('sweepRange').textContent = `${fmtHz(fr.start)} – ${fmtHz(fr.stop)} · bin ${fmtHz(fr.bin_width)}`; }
  else $('iqStat').textContent = `#${fr.seq} · ${fps} fps · ${fr.points}-pt FFT · RBW ≈ ${fmtHz(fr.settings?.rbw || fr.bin_width)}${fr.dropped ? ` · ${fr.dropped} blocks not shown` : ''}`;
}

// ---------------------------------------------------------------- sweep / iq sessions
function gains() { return { lna: +$('lna').value, vga: +$('vga').value, amp: $('amp').checked }; }
async function toggleSweep() {
  const rf = state.rf; if (!rf || state.busy) return; state.busy = true;
  try {
    if (state.session.state === 'sweep') { await rf.stop(); return; }
    const f_min = parseFloat($('fMin').value) * 1e6, f_max = parseFloat($('fMax').value) * 1e6; if (!(f_min < f_max)) throw new Error('start must be below stop');
    const r = await rf.startSweep({ f_min, f_max, bin_width: $('binWidth').value ? +$('binWidth').value : null, ...gains() });
    state.session = { state: r.state, mode: r.mode, settings: r.settings }; clearTrace(); refreshSessionUi();
  } catch (e) { con.err(e.message); setStatus(e.message, 'err'); } finally { state.busy = false; }
}
async function toggleIq() {
  const rf = state.rf; if (!rf || state.busy) return; state.busy = true;
  try {
    if (state.session.state === 'iq') { await rf.stop(); return; }
    const r = await rf.startIq({ center: parseFloat($('center').value) * 1e6, sample_rate: +$('sampleRate').value, fft_size: +$('fftSize').value, avg: +$('avgN').value, ...gains() });
    state.session = { state: r.state, mode: r.mode, settings: r.settings }; clearTrace(); refreshSessionUi();
    $('recEstimate').textContent = estimateText();
  } catch (e) { con.err(e.message); setStatus(e.message, 'err'); } finally { state.busy = false; }
}
async function takeSnapshot(auto) {
  const rf = state.rf; if (!rf || state.session.state !== 'iq' || (auto && state.busy)) return;
  try { await rf.snapshot(settings.snapshotCount, auto); } catch (e) { if (!auto) con.err(e.message); }
}
function estimateText() { const sr = +$('sampleRate').value, s = +$('recMax').value || 0; return `≈ ${(sr * 2 * s / 1e6).toFixed(0)} MB for ${s} s at ${fmtHz(sr)} (2 bytes per sample)`; }
function refreshIqRec(d) {
  const active = !!d.active;
  $('recIqBtn').textContent = active ? 'Stop' : 'Start'; $('recIqBtn').classList.toggle('running', active);
  $('recBadge').hidden = !active && !recorder.on; if (active) $('recBadge').textContent = `● REC ${d.seconds ?? 0} s`;
  if (d.path) $('recPath').textContent = d.path; if (d.bytes != null) $('recBytes').textContent = `${(d.bytes / 1e6).toFixed(1)} MB · ${d.seconds ?? 0} s`;
  if (!active && d.path) con.dim(`recording saved: ${d.path}`);
  state.iqRec = active;
}
async function toggleIqRec() {
  const rf = state.rf; if (!rf) return;
  try { if (state.iqRec) refreshIqRec(await rf.recordStop()); else refreshIqRec(await rf.recordStart(+$('recMax').value || 10)); } catch (e) { con.err(e.message); $('recEstimate').textContent = e.message; }
}
async function transmitTone() {
  const rf = state.rf; if (!rf || !rf.allowTx) return;
  const freq = parseFloat($('txFreq').value) * 1e6, duration = Math.min(+$('txDur').value || 5, state.hello?.tx_max_seconds || 30), txvga = +$('txvga').value, amplitude = +$('txAmpl').value, amp = $('txAmp').checked;
  if (!confirm(`Transmit a test tone?\n\n${fmtHz(freq, 4)} for ${duration} s\nTX VGA ${txvga} dB, DAC amplitude ${amplitude}/127, amplifier ${amp ? 'ON (+14 dB)' : 'off'}\n\nMake sure the antenna port is connected to a dummy load or an antenna you are allowed to use on this frequency. The page cannot check either.`)) return;
  try { $('txStatus').textContent = 'starting…'; await rf.txTone({ freq, duration, txvga, amplitude, amp }); } catch (e) { con.err(e.message); $('txStatus').textContent = e.message; }
}

// ---------------------------------------------------------------- trace handling (same as tinysa-web)
function sameGrid(a, b) { return a && b && a.pts === b.pts && a.start === b.start && a.stop === b.stop; }
function resetLayers() { state.layers = { max: null, min: null, avg: null }; state.avgN = 0; }
function clearTrace() { state.sweep = null; state.held = null; state.history = []; resetLayers(); state.snap = null; chart.dirty = true; }
function acceptSweep(sw) {
  if (!sameGrid(state.sweep, sw)) { resetLayers(); state.history = []; state.markers = state.markers.filter(f => f >= sw.start && f <= sw.stop); }
  state.sweep = sw; if (sw.mode === 'sweep') recorder.addSweep(sw);
  const L = state.layers;
  if (state.maxOn) L.max = L.max ? holdMax(L.max, sw.dbm) : sw.dbm.slice();
  if (state.minOn) L.min = L.min ? holdMin(L.min, sw.dbm) : sw.dbm.slice();
  if (state.avgOn) { state.avgN = Math.min(state.avgN + 1, settings.avgCount); L.avg = L.avg ? averageInto(L.avg, sw.dbm, state.avgN) : sw.dbm.slice(); }
  state.history.unshift(sw.dbm.slice()); if (state.history.length > WATERFALL_ROWS) state.history.pop();
  ['csvBtn', 'pngBtn', 'clearBtn', 'peakBtn', 'peaksBtn', 'clearMarkersBtn'].forEach(id => $(id).disabled = false);
  chart.dirty = true; renderMarkers();
}

// ---------------------------------------------------------------- panes
function renderPane(pane) {
  const canvas = pane.canvas, dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return null;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const v = pane.view, sw = state.sweep;
  if (v === 'iqtime') { renderIqTime(ctx, W, H, state.snap, Math.min(2048, state.snap?.count || 2048)); return null; }
  if (v === 'constellation') { renderConstellation(ctx, W, H, state.snap, state.lut); return null; }
  if (!sw) { ctx.font = '13px ' + cssVar('--font'); ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(state.rf ? 'Start a sweep or an IQ session.' : 'Connect to the bridge, or try the demo.', W / 2, H / 2); return null; }
  let g;
  if (v === 'waterfall') g = renderWaterfall(ctx, W, H, sw, state.history, state.markers, chart.hover, state.lut, levelRange(), sw.unit);
  else { g = renderSpectrum(ctx, W, H, sw, state.layers, state.held, state.markers, chart.hover, null, levelRange(), sw.unit); drawExtras(ctx, g, sw); }
  return g;
}
function drawExtras(ctx, g, sw) {
  const nf = noiseFloor(sw.dbm), y = g.sy(nf);
  ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([2, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(g.pad.l, y); ctx.lineTo(g.pad.l + g.pw, y); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = cssVar('--ink-3'); ctx.font = '11px ' + cssVar('--font'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(`median ${nf.toFixed(1)} ${sw.unit}`, g.pad.l + g.pw - 4, y - 2);
  if (sw.mode === 'iq') { const x = g.sx((sw.start + sw.stop) / 2); ctx.fillStyle = cssVar('--ink-3'); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('DC', x, g.pad.t + 2); }
}
function renderAll() { chart.geoms = panes.panes.map(renderPane); }
function tick() { if (chart.dirty) { chart.dirty = false; renderAll(); } requestAnimationFrame(tick); }
const resizer = new ResizeObserver(() => chart.dirty = true);
function pointAt(pane, e) { const sw = state.sweep, g = chart.geoms[pane.i]; if (!sw || !g) return null; const r = pane.canvas.getBoundingClientRect(), mx = e.clientX - r.left; if (mx < g.pad.l || mx > g.pad.l + g.pw) return null; return nearestIndex(sw.f, g.fx(mx)); }
function wirePanes() {
  for (const pane of panes.panes) {
    if (pane.wired) continue; pane.wired = true; resizer.observe(pane.canvas);
    pane.canvas.addEventListener('pointermove', e => {
      if (!['spectrum', 'waterfall'].includes(pane.view)) return;
      const i = pointAt(pane, e); if (i !== chart.hover) { chart.hover = i; chart.dirty = true; }
      if (i == null) { pane.tip.style.display = 'none'; return; }
      const sw = state.sweep, g = chart.geoms[pane.i], L = state.layers;
      pane.tip.style.display = 'block'; pane.tip.style.left = g.sx(sw.f[i]) + 'px'; pane.tip.style.top = g.sy(sw.dbm[i]) + 'px';
      pane.tip.textContent = `${fmtHz(sw.f[i])}  ${sw.dbm[i].toFixed(1)} ${sw.unit}` + (L.max ? `  max ${L.max[i].toFixed(1)}` : '') + (L.min ? `  min ${L.min[i].toFixed(1)}` : '') + (L.avg ? `  avg ${L.avg[i].toFixed(1)}` : '');
    });
    pane.canvas.addEventListener('pointerleave', () => { chart.hover = null; chart.dirty = true; pane.tip.style.display = 'none'; });
    pane.canvas.addEventListener('click', e => { if (!['spectrum', 'waterfall'].includes(pane.view)) return; const i = pointAt(pane, e); if (i == null) return; addMarker(state.sweep.f[i]); });
  }
  document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.layout === panes.layout)));
}
function toggleLayer(which) {
  const key = which + 'On'; state[key] = !state[key]; $(which + 'Btn').setAttribute('aria-pressed', String(state[key]));
  if (!state[key]) { state.layers[which] = null; if (which === 'avg') state.avgN = 0; }
  else if (state.sweep) { state.layers[which] = state.sweep.dbm.slice(); if (which === 'avg') state.avgN = 1; }
  buildLegend(); renderMarkers(); chart.dirty = true;
}

// ---------------------------------------------------------------- markers
function addMarker(f) { if (state.markers.length >= settings.maxMarkers) state.markers.shift(); state.markers.push(f); renderMarkers(); chart.dirty = true; }
function renderMarkers() {
  const body = $('markerBody'); body.innerHTML = ''; const sw = state.sweep; $('tuneBtn').disabled = !state.rf || !state.markers.length;
  if (!sw) { $('markerEmpty').hidden = false; return; }
  const ref = state.markers.length ? nearestIndex(sw.f, state.markers[0]) : null;
  state.markers.forEach((mf, k) => {
    const i = nearestIndex(sw.f, mf), L = state.layers;
    const isPk = i > 0 && i < sw.pts - 1 && sw.dbm[i] >= sw.dbm[i - 1] && sw.dbm[i] >= sw.dbm[i + 1];
    const pk = isPk ? interpolatePeak(sw.f, sw.dbm, i) : { f: sw.f[i], dbm: sw.dbm[i] }, bw = isPk ? bandwidth3dB(sw.f, sw.dbm, i) : null;
    const dl = k === 0 || ref == null ? '—' : (sw.dbm[i] - sw.dbm[ref]).toFixed(1), df = k === 0 || ref == null ? '—' : (sw.f[i] - sw.f[ref] >= 0 ? '+' : '−') + fmtHz(Math.abs(sw.f[i] - sw.f[ref]));
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${k + 1}</td><td>${fmtHz(pk.f, 4)}${isPk ? '*' : ''}</td><td>${pk.dbm.toFixed(1)}</td><td>${L.max ? L.max[i].toFixed(1) : '—'}</td><td>${bw == null ? '—' : fmtHz(bw, 1)}</td><td>${dl}</td><td>${df}</td><td><button type="button" title="Remove marker" data-k="${k}">×</button></td>`;
    body.appendChild(tr);
  });
  $('markerEmpty').hidden = state.markers.length > 0;
  if (state.markers.length >= 2) { const a = nearestIndex(sw.f, state.markers[0]), b = nearestIndex(sw.f, state.markers[1]), lo = Math.min(a, b), hi = Math.max(a, b); $('bandPower').textContent = `Band power M1–M2: ${channelPowerDbm(sw.dbm, lo, hi).toFixed(1)} ${sw.unit} over ${fmtHz(sw.f[hi] - sw.f[lo])} (${hi - lo + 1} bins summed). * = interpolated peak.`; }
  else $('bandPower').textContent = state.markers.length ? '* = peak frequency by parabolic interpolation between bins.' : '';
}
function buildLegend() {
  const v = panes.panes.some(p => p.view === 'spectrum') ? 'spectrum' : panes.panes[0].view; let items = [['--trace', state.sweep ? `live (${state.sweep.mode})` : 'live']];
  if (v === 'waterfall') { const [a, b] = levelRange(); items = [['--trace', 'live'], [`background:${cssGradient(settings.palette)}`, `${a} → ${b} dBFS`]]; }
  else { if (state.layers.max) items.push(['--maxhold', 'max hold']); if (state.layers.min) items.push(['--minhold', 'min hold']); if (state.layers.avg) items.push(['--avg', `average (${settings.avgCount})`]); if (state.held) items.push(['--held', 'held trace']); }
  if (panes.panes.some(p => p.view === 'iqtime')) items.push(['--trace', 'I'], ['--minhold', 'Q']);
  $('legend').innerHTML = items.map(([c, l]) => `<span><i style="${c.startsWith('--') ? 'background:' + cssVar(c) : c}"></i>${l}</span>`).join('');
}
async function tuneToMarker() {
  const rf = state.rf; if (!rf || !state.markers.length || state.busy) return;
  $('center').value = (state.markers[0] / 1e6).toPrecision(8).replace(/\.?0+$/, '');
  sidebar.open('iq');
  if (state.session.state !== 'idle') { state.busy = true; try { await rf.stop(); } catch {} finally { state.busy = false; } }
  await toggleIq();
}

// ---------------------------------------------------------------- manual console
async function sendManual(line) {
  if (!state.rf) { con.err('not connected'); return; }
  const m = /^(\S+)\s*(\{.*\})?$/.exec(line.trim()); if (!m) { con.err('usage: method.name {json params}'); return; }
  let params = {}; if (m[2]) { try { params = JSON.parse(m[2]); } catch { con.err('params must be JSON'); return; } }
  try { const r = await state.rf.raw(m[1], params); if (m[1] === 'device.info' && r?.text) con.reply(r.text); } catch (e) { con.err(e.message); }
}

// ---------------------------------------------------------------- recording (sweep frames, on the page)
function refreshRec() {
  const n = recorder.sweeps.length;
  $('recSweeps').textContent = n; $('recSize').textContent = (recorder.bytes() / 1024).toFixed(0) + ' kB';
  $('recBtn').textContent = recorder.on ? 'Stop recording frames' : 'Start recording frames'; $('recBtn').classList.toggle('running', recorder.on); $('recBtn').setAttribute('aria-pressed', String(recorder.on));
  $('recBadge').hidden = !recorder.on && !state.iqRec; if (recorder.on) $('recBadge').textContent = `● REC ${n}`;
  $('recWfBtn').disabled = $('recSweepsBtn').disabled = $('recJsonBtn').disabled = $('recClearBtn').disabled = !n;
}
recorder.onChange = refreshRec;

// ---------------------------------------------------------------- wiring
$('presetSel').innerHTML = '<option value="">—</option>' + PRESETS.map(p => `<option value="${p.key}">${p.name}</option>`).join('');
$('presetSel').addEventListener('change', () => { const p = PRESETS.find(x => x.key === $('presetSel').value); if (!p) return; $('fMin').value = p.f_min / 1e6; $('fMax').value = p.f_max / 1e6; $('center').value = p.center / 1e6; $('sampleRate').value = String(p.sample_rate); updateRbw(); });
$('sampleRate').innerHTML = LIMITS.sampleRates.map(r => `<option value="${r}"${r === 8e6 ? ' selected' : ''}>${fmtHz(r)}${r < LIMITS.srWarnBelow ? ' (library warns)' : ''}</option>`).join('');
$('fftSize').innerHTML = LIMITS.fftSizes.map(n => `<option value="${n}"${n === 2048 ? ' selected' : ''}>${n}</option>`).join('');
function updateRbw() { const sr = +$('sampleRate').value, n = +$('fftSize').value; $('rbwHint').textContent = `RBW ≈ ${fmtHz(sr / n * 1.5)} (Hann) · span ${fmtHz(sr)} · ${fmtHz(sr / n)} per bin`; $('recEstimate').textContent = estimateText(); }
['sampleRate', 'fftSize', 'recMax'].forEach(id => $(id).addEventListener('change', updateRbw)); updateRbw();
$('lna').addEventListener('input', () => $('lnaOut').textContent = snapGain('lna', +$('lna').value)); $('vga').addEventListener('input', () => $('vgaOut').textContent = snapGain('vga', +$('vga').value));
$('txvga').addEventListener('input', () => $('txvgaOut').textContent = $('txvga').value); $('txAmpl').addEventListener('input', () => $('txAmplOut').textContent = $('txAmpl').value);
$('connectBtn').addEventListener('click', () => state.rf ? disconnect() : connect(false));
$('demoBtn').addEventListener('click', () => state.rf ? disconnect() : connect(true));
$('preflightBtn').addEventListener('click', async () => { if (!state.rf) return; try { state.preflight = await state.rf.preflight(); showPreflight(state.preflight); } catch (e) { con.err(e.message); } });
$('detectBtn').addEventListener('click', async () => { if (!state.rf) return; try { const d = await state.rf.detect(); con.reply(JSON.stringify(d, null, 1)); } catch (e) { con.err(e.message); } });
$('sweepBtn').addEventListener('click', toggleSweep); $('iqBtn').addEventListener('click', toggleIq); $('snapBtn').addEventListener('click', () => takeSnapshot(false));
$('recIqBtn').addEventListener('click', toggleIqRec); $('txBtn').addEventListener('click', transmitTone);
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => panes.setLayout(+b.dataset.layout)));
['max', 'min', 'avg'].forEach(w => $(w + 'Btn').addEventListener('click', () => toggleLayer(w)));
$('holdBtn').addEventListener('click', () => { if (state.held) state.held = null; else if (state.sweep) state.held = { ...state.sweep, f: state.sweep.f.slice(), dbm: state.sweep.dbm.slice() }; $('holdBtn').setAttribute('aria-pressed', String(!!state.held)); buildLegend(); chart.dirty = true; });
$('clearBtn').addEventListener('click', () => { clearTrace(); state.markers = []; $('holdBtn').setAttribute('aria-pressed', 'false'); renderMarkers(); buildLegend(); ['csvBtn', 'pngBtn', 'clearBtn', 'peakBtn', 'peaksBtn', 'clearMarkersBtn'].forEach(id => $(id).disabled = true); });
$('peakBtn').addEventListener('click', () => { if (state.sweep) addMarker(state.sweep.f[peakIndex(state.sweep.dbm)]); });
$('peaksBtn').addEventListener('click', () => { const sw = state.sweep; if (!sw) return; const idx = findPeaks(sw.dbm, { count: 4 }); if (!idx.length) { $('markerStatus').textContent = 'no peaks above the noise'; return; } state.markers = idx.map(i => sw.f[i]); renderMarkers(); chart.dirty = true; $('markerStatus').textContent = `${idx.length} peak(s) marked`; });
$('tuneBtn').addEventListener('click', tuneToMarker);
$('clearMarkersBtn').addEventListener('click', () => { state.markers = []; renderMarkers(); chart.dirty = true; });
$('markerBody').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.markers.splice(+b.dataset.k, 1); renderMarkers(); chart.dirty = true; });
$('csvBtn').addEventListener('click', () => download(`hackrf-${state.sweep.mode}-${stamp()}.csv`, csvBlob(state.sweep)));
$('pngBtn').addEventListener('click', () => { const p = panes.panes[0]; canvasPng(p.canvas, `hackrf-${p.view}-${stamp()}.png`); });
$('iqCsvBtn').addEventListener('click', () => { const s = state.snap; if (!s) return; const rows = [`# hackrf-web IQ snapshot: center_hz=${s.center} sample_rate=${s.sample_rate} count=${s.count} int8`, 'i,q']; for (let i = 0; i < s.count; i++) rows.push(`${s.iq[2 * i]},${s.iq[2 * i + 1]}`); download(`hackrf-iq-${stamp()}.csv`, new Blob([rows.join('\n') + '\n'], { type: 'text/csv' })); });
$('diagBtn').addEventListener('click', async () => { if (!state.rf) return; let status = null; try { status = await state.rf.status(); } catch (e) { status = { error: e.message }; } download(`hackrf-diag-${stamp()}.json`, new Blob([JSON.stringify({ tool: 'hackrf-web', version: APP_VERSION, when: new Date().toISOString(), userAgent: navigator.userAgent, origin: location.origin, bridge: state.rf.link.info(), hello: state.hello, preflight: state.preflight, status, lastFrames: state.lastHeaders, settings }, null, 2)], { type: 'application/json' })); });
$('recBtn').addEventListener('click', () => { if (recorder.on) recorder.stop(); else { recorder.start(); con.dim('recording sweep frames on the page'); } });
$('recWfBtn').addEventListener('click', () => download(`hackrf-waterfall-${stamp()}.csv`, recorder.waterfallCsv()));
$('recSweepsBtn').addEventListener('click', () => download(`hackrf-frames-${stamp()}.csv`, recorder.sweepsCsv()));
$('recJsonBtn').addEventListener('click', () => download(`hackrf-recording-${stamp()}.json`, recorder.jsonBlob({ version: APP_VERSION, hello: state.hello, settings: state.session.settings })));
$('recClearBtn').addEventListener('click', () => { if (confirm('Discard the recorded frames?')) recorder.clear(); });
initSettingsPanel($('settingsForm'), key => { if (key === 'palette') state.lut = buildLut(settings.palette); if (key === 'autoSnapshot') refreshSessionUi(); buildLegend(); chart.dirty = true; });
window.addEventListener('beforeunload', e => { if (recorder.on && recorder.sweeps.length) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('hashchange', () => { if (readHash() && !state.rf) connect(false); });

$('appVersion').textContent = 'v' + APP_VERSION;
$('bridgeAddr').value = settings.bridgeAddr;
wirePanes(); renderMarkers(); buildLegend(); refreshRec(); setEnabled(false); tick();
if (readHash()) connect(false);
