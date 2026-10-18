// about.js — About page: what hackrf-web does, how the bridge fits, what is next.
// Opened from the "About" entry at the bottom of the sidebar (or #about in the URL).
// SPDX-License-Identifier: GPL-2.0-only
import { LIMITS } from '../device/models.js';
import { fmtHz } from '../sa.js';

function h(sel, attrs = {}, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids.flat().filter(k => k != null));
  return el;
}
const li = (...c) => h('li', {}, ...c);
const code = s => h('code', {}, s);

export function initAbout(root, link, swap, opts) {
  render(root, opts);
  let open = false;
  function show(on) {
    open = on; root.hidden = !on; for (const el of swap) el.hidden = on;
    link.setAttribute('aria-current', on ? 'page' : 'false'); link.setAttribute('aria-expanded', String(on));
    if (on) root.scrollIntoView({ block: 'start' });
    opts.onToggle?.(on);
  }
  link.addEventListener('click', e => { e.preventDefault(); show(!open); history.replaceState(null, '', open ? '#about' : location.pathname + location.search + (location.hash.startsWith('#bridge') ? location.hash : '')); });
  root.querySelector('#aboutClose').addEventListener('click', () => { show(false); history.replaceState(null, '', location.pathname + location.search); });
  if (location.hash === '#about') show(true);
  return { show, get open() { return open; } };
}

function render(root, { version }) {
  const badge = (text, cls) => h('span.badge' + (cls ? '.' + cls : ''), {}, text);
  root.replaceChildren(
    h('div.head', {}, h('h2', {}, 'About hackrf-web'), h('p.lede', {}, 'What this page does, how it reaches the radio, and where it is going.'), h('button.btn.small', { id: 'aboutClose', type: 'button' }, 'Back to plots')),
    h('div.cols', {},
      h('div.card', {}, h('h3', {}, 'What it is'),
        h('p', {}, 'A quick bench page for the HackRF One: live spectrum and waterfall from ', code('hackrf_sweep'), ' across any span up to 6 GHz, or from IQ at one centre frequency with the FFT done locally; IQ snapshots as time-domain and constellation views; IQ recording to SigMF; and a transmit section that stays locked unless you unlock it on purpose.'),
        h('p', {}, 'It is the browser companion to the ', h('a', { href: 'https://github.com/LC-Linkous/hackRF_python' }, 'hackRF_python'), ' library (', code('hackrfpy'), '). It is deliberately not the whole library: the page covers the plug-in-and-look workflow, and scripts cover everything else.'),
        h('p', {}, 'It is the third tool on the ', h('a', { href: 'https://github.com/LC-Linkous/nanovna-web' }, 'nanovna-web'), ' / ', h('a', { href: 'https://github.com/LC-Linkous/tinysa-web' }, 'tinysa-web'), ' kit: same sidebar, console, windows, palettes and layout; a different transport and a different device layer.')),
      h('div.card', {}, h('h3', {}, 'How it reaches the radio'),
        h('p', {}, 'The HackRF is not a serial device, so there is no Web Serial path. A small Python ', h('b', {}, 'bridge'), ' runs on the computer the board is plugged into:'),
        h('ol.steps', {},
          li(code('pip install hackrf-web'), ' then ', code('hackrf-web'), '. It starts a WebSocket server on 127.0.0.1 only, prints a per-launch token, and opens this page with the token in the URL.'),
          li('The page calls the bridge; the bridge calls ', code('hackrfpy'), '; ', code('hackrfpy'), ' runs the ', code('hackrf-tools'), ' binaries. The page never sees an argv or a raw stream it did not ask for.'),
          li('Spectrum frames come back at up to 12 per second. In IQ mode the bridge decodes, windows and FFTs the samples; 40 MB/s of int8 never crosses the socket.'),
          li('Recordings are written by the bridge next to its working directory, as interleaved int8 with a SigMF sidecar, with a mandatory time cap and a disk check first.')),
        h('p.hint', {}, 'The contract between the two is ', h('a', { href: 'protocol/' }, 'PROTOCOL.md'), '. ', code('hackrf-web --fake'), ' runs the bridge against a simulated board; ', h('i', {}, 'Try without hardware'), ' on this page replays recorded frames with no bridge at all.'))),
    h('div.cols', {},
      h('div.card', {}, h('h3', {}, 'Envelope ', badge(LIMITS.name)),
        h('dl.kv', {},
          h('dt', {}, 'Frequency'), h('dd', {}, `${fmtHz(LIMITS.freqMin)} – ${fmtHz(LIMITS.freqMax)}`),
          h('dt', {}, 'Sample rate'), h('dd', {}, `${fmtHz(LIMITS.srMin)} – ${fmtHz(LIMITS.srMax)} (warns below ${fmtHz(LIMITS.srWarnBelow)})`),
          h('dt', {}, 'Gains'), h('dd', {}, `LNA 0–40 dB in 8 dB steps, VGA 0–62 dB in 2 dB steps, amp +${LIMITS.ampDb} dB`),
          h('dt', {}, 'Samples'), h('dd', {}, 'signed 8-bit I and Q, interleaved'),
          h('dt', {}, 'Levels'), h('dd', {}, 'dBFS — the HackRF is not a calibrated instrument')),
        h('p.hint', {}, 'From ', code('hackrfpy/constants.py'), '. The page checks requests against these and the library checks them again; gains are reported back as snapped.')),
      h('div.card', {}, h('h3', {}, 'Honest limits'),
        h('ul', { style: 'margin:0;padding-left:1.2em' },
          li('Levels are relative (dBFS) and depend on the gains. Nothing on this page is in dBm.'),
          li('Every retune in IQ mode restarts the ', code('hackrf_transfer'), ' child; expect a second of gap. Sweep mode restarts for any setting change too.'),
          li('The centre of an IQ span has the HackRF DC spike. It is not a signal.'),
          li('Transmit needs the bridge started with ', code('--allow-tx'), ', a confirm, and a duration. The page cannot know what the antenna port is connected to or whether a band is legal to use where you are.'),
          li('Only one program can hold the HackRF: close the bridge before running a script, and vice versa.'),
          li('No audio, no demodulation, no sweep-mode recording on the bridge (the page records sweep frames itself), no calibration files yet.')))),
    h('div.cols', {},
      h('div.card', {}, h('h3', {}, 'Next'),
        h('ul', { style: 'margin:0;padding-left:1.2em' },
          li('Digital tuning inside the IQ band without a restart, and offset tuning to move the DC spike out of the way.'),
          li('Channel power / SNR / occupied bandwidth over a marked band.'),
          li('Calibration file from the library\'s ', code('calibrate.py'), ' → approximate dBm.'),
          li('Transmit from a file, with the same gates.'))),
      h('div.card', {}, h('h3', {}, 'Help validate it'),
        h('p', {}, 'Run ', code('hackrf-web --doctor'), ' first; it prints hackrfpy\'s preflight report. Then connect, start a sweep of the FM band, and compare with what you expect. If something is off, ', h('i', {}, 'Diagnostics → Download report'), ' bundles the preflight, the session status and the last frame headers into one JSON to attach to an issue.'),
        h('p.hint', {}, 'See ', h('a', { href: 'contributing/' }, 'CONTRIBUTING.md'), ' and the short ', h('a', { href: 'https://github.com/LC-Linkous/hackrf-web/blob/main/CODE_OF_CONDUCT.md' }, 'code of conduct'), '.'))),
    h('p.hint', {}, 'hackrf-web ', h('span.mono', {}, 'v' + version), ' · GPL-2.0 · ', h('a', { href: 'readme/' }, 'README'), ' · ', h('a', { href: 'protocol/' }, 'bridge protocol'), ' · ', h('a', { href: 'changelog/' }, 'changelog'), ' · ', h('a', { href: 'https://github.com/LC-Linkous/hackrf-web' }, 'source'), ' · ', h('a', { href: 'https://github.com/LC-Linkous/hackRF_python' }, 'hackRF_python'), '. Not affiliated with Great Scott Gadgets or the HackRF project.'));
}
