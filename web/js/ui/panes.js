// panes.js — the plot area as 1, 2 or 4 windows, each showing its own view.
// Each pane owns a canvas and a tooltip; main.js decides what to draw in it.
// SPDX-License-Identifier: GPL-2.0-only

const KEY = 'tinysa-web.panes';

/**
 * views: { key: label } — what a pane can show.
 * onChange() — called after any layout or view change.
 * Returns { panes, setLayout(n), layout }.
 */
export function createPanes(container, views, onChange) {
  const st = { layout: 1, views: ['spectrum', 'waterfall', 'peakhist', 'generator'], panes: [] };
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && [1, 2, 4].includes(s.layout) && Array.isArray(s.views)) { st.layout = s.layout; st.views = s.views.map(v => views[v] ? v : 'spectrum'); } } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ layout: st.layout, views: st.views })); } catch {} };

  function build(initial) {
    container.innerHTML = ''; container.dataset.layout = st.layout; st.panes = [];
    for (let i = 0; i < st.layout; i++) {
      const el = document.createElement('section'); el.className = 'pane'; el.dataset.pane = i;
      const head = document.createElement('div'); head.className = 'pane-head';
      const tabs = document.createElement('div'); tabs.className = 'views';
      for (const [k, label] of Object.entries(views)) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.dataset.view = k; b.textContent = label; b.setAttribute('aria-pressed', String(st.views[i] === k)); b.addEventListener('click', () => { st.views[i] = k; tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.view === k))); body.dataset.view = k; save(); onChange(); }); tabs.appendChild(b); }
      head.appendChild(tabs);
      const body = document.createElement('div'); body.className = 'chart-wrap'; body.dataset.view = st.views[i];
      const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'plot');
      const tip = document.createElement('div'); tip.className = 'tip';
      const slot = document.createElement('div'); slot.className = 'pane-slot';      // non-canvas content (the generator panel)
      body.append(canvas, tip, slot); el.append(head, body); container.appendChild(el);
      st.panes.push({ i, el, canvas, tip, slot, get view() { return st.views[i]; } });
    }
    if (!initial) onChange();
  }
  function setLayout(n) { if (![1, 2, 4].includes(n)) return; st.layout = n; save(); build(); }
  build(true);
  return { get panes() { return st.panes; }, get layout() { return st.layout; }, setLayout, viewOf: i => st.views[i] };
}
