// The in-match menu: pick how your team attacks (any time, also mid-match), resume or quit.
// Each tactic card draws its shape on a small pitch: where every shirt number plays, the short
// passing links between them, and the runs in behind.

import { h, hex } from '../ui/dom';
import { SHIRT, TACTIC_IDS, TACTICS, type Tactic, type TacticDef } from './tactics';
import { HALF_L, HALF_W } from './types';

/** Pitch metres to diagram units (the diagram is the pitch on its side: attacking to the right). */
const S = 2;
const W = HALF_L * 2 * S;
const H = HALF_W * 2 * S;
const px = (y: number) => ((y + HALF_L) * S).toFixed(1);
const py = (x: number) => ((x + HALF_W) * S).toFixed(1);

/** Where each role stands in the tactic's attacking shape (team coordinates), the keeper first. */
export function shapeOf(t: TacticDef): { x: number; y: number }[] {
  // Centred on the middle of the pitch, so the three shapes compare side by side.
  const out = [{ x: 0, y: -HALF_L + 1.6 }];
  for (let r = 1; r < t.jobs.length; r++) {
    const j = t.jobs[r]!;
    out.push({ x: j.x, y: Math.min(j.top, j.ahead + 1) });
  }
  return out;
}

function diagram(t: TacticDef, color: number): string {
  const pts = shapeOf(t);
  const line = 'stroke="rgba(255,255,255,0.32)" stroke-width="0.9" fill="none"';
  let svg = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="3" ${line}/>`;
  svg += `<line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" ${line}/><circle cx="${W / 2}" cy="${H / 2}" r="${7 * S}" ${line}/>`;
  for (const side of [0, 1]) {
    const x0 = side ? W - 8 * S : 0;
    svg += `<rect x="${x0}" y="${py(-9)}" width="${8 * S}" height="${18 * S}" ${line}/>`;
  }
  // Passing links: teammates close enough for a short pass.
  for (let a = 1; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
      if (d > 16) continue;
      svg += `<line x1="${px(pts[a].y)}" y1="${py(pts[a].x)}" x2="${px(pts[b].y)}" y2="${py(pts[b].x)}" stroke="rgba(198,255,0,${(0.9 - d / 26).toFixed(2)})" stroke-width="1.3" stroke-dasharray="2.5 2"/>`;
    }
  }
  // Runs in behind.
  for (let r = 1; r < pts.length; r++) {
    const j = t.jobs[r]!;
    if (j.runs < 0.5) continue;
    const p = pts[r];
    const to = { x: p.x * 0.6, y: Math.min(HALF_L - 6, p.y + 6 + 9 * j.runs) };
    svg += `<path d="M${px(p.y + 4)} ${py(p.x)} L${px(to.y)} ${py(to.x)}" stroke="#ffd166" stroke-width="1.6" fill="none" stroke-linecap="round" marker-end="url(#arrow-${t.id})"/>`;
  }
  svg += `<defs><marker id="arrow-${t.id}" viewBox="0 0 6 6" refX="4" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6z" fill="#ffd166"/></marker></defs>`;
  pts.forEach((p, r) => {
    const fill = r === 0 ? '#ffc21a' : hex(color);
    svg += `<circle cx="${px(p.y)}" cy="${py(p.x)}" r="4.6" fill="${fill}" stroke="#fff" stroke-width="1"/>`;
    svg += `<text x="${px(p.y)}" y="${(Number(py(p.x)) + 2.1).toFixed(1)}" text-anchor="middle" font-size="6" font-weight="800" fill="${r === 0 ? '#111' : '#fff'}">${SHIRT[r]}</text>`;
  });
  return svg + '</svg>';
}

export interface PauseMenuOptions {
  /** Whether the match is stopped while the menu is open (false on Wi-Fi: it goes on). */
  paused: boolean;
  current: Tactic;
  color: number;
  onPick: (t: Tactic) => void;
  onResume: () => void;
  onQuit: () => void;
}

export function pauseMenu(o: PauseMenuOptions): HTMLElement {
  const cards = TACTIC_IDS.map((id) => {
    const t = TACTICS[id];
    const art = h('span', { class: 'tactic-art' });
    art.innerHTML = diagram(t, o.color);
    return h(
      'button',
      {
        class: 'tactic' + (id === o.current ? ' on' : ''),
        id: `tactic-${id}`,
        'data-tactic': id,
        onclick: () => {
          for (const c of cards) c.classList.toggle('on', c.dataset.tactic === id);
          o.onPick(id);
        },
      },
      art,
      h('b', {}, t.name),
      h('span', { class: 'tactic-blurb' }, t.blurb),
    );
  });
  return h(
    'div',
    { class: 'pause-menu' },
    h(
      'div',
      { class: 'pause-card glass' },
      h(
        'div',
        { class: 'pause-head' },
        h('h3', {}, o.paused ? 'PAUSED' : 'TACTICS'),
        h('span', { class: 'muted small' }, o.paused ? 'How your team attacks' : 'The match goes on while you choose'),
      ),
      h('div', { class: 'tactics' }, ...cards),
      h(
        'div',
        { class: 'pause-actions' },
        h('button', { class: 'btn ghost', id: 'quit', onclick: o.onQuit }, 'Quit match'),
        h('button', { class: 'btn', id: 'resume', onclick: o.onResume }, 'Resume'),
      ),
    ),
  );
}
