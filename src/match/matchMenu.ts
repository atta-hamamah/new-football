import type { Stage } from '../render/app';
import { sfx } from '../ui/audio';
import { h, showScreen } from '../ui/dom';
import { MatchMode } from './matchMode';
import type { Session } from './session';
import { LocalSession } from './session';

export let current: MatchMode | null = null;

/** Starts a match screen for any session (local or Wi-Fi). */
export function playSession(stage: Stage, session: Session, back: () => void): MatchMode {
  showScreen(null);
  const mode = new MatchMode(stage, session, () => {
    current = null;
    stage.idle(); // destroys the match (and closes its session)
    back();
  });
  current = mode;
  (window as unknown as { __match: MatchMode | null }).__match = mode;
  stage.show(mode);
  return mode;
}

export function showMatchMenu(stage: Stage, back: () => void): void {
  let difficulty = 1;
  const chips = ['Easy', 'Normal', 'Hard'].map((label, i) =>
    h(
      'button',
      {
        class: 'chip-btn' + (i === difficulty ? ' on' : ''),
        onclick: (e) => {
          sfx.click();
          difficulty = i;
          chips.forEach((c) => c.classList.remove('on'));
          (e.currentTarget as HTMLElement).classList.add('on');
        },
      },
      label,
    ),
  );
  const again = () => showMatchMenu(stage, back);
  showScreen(
    h(
      'div',
      { class: 'menu match-menu' },
      h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: back }, '←'), h('h2', {}, '6v6 MATCH'), h('span', {})),
      h('p', { class: 'tagline' }, 'Pass, sprint, tackle. Every shot is a duel with the keeper.'),
      h(
        'div',
        { class: 'col' },
        h('div', { class: 'section' }, h('div', { class: 'section-title' }, '🤖 VS COMPUTER'), h('div', { class: 'chips' }, ...chips)),
        h(
          'button',
          {
            class: 'btn big',
            id: 'play-cpu',
            onclick: () => {
              sfx.unlock();
              sfx.click();
              playSession(stage, new LocalSession(difficulty), again);
            },
          },
          'Kick off',
        ),
        h('div', { class: 'section-title spaced' }, '📶 WI-FI WITH FRIENDS'),
        h(
          'button',
          {
            class: 'btn big alt',
            id: 'host-wifi',
            onclick: () => {
              sfx.unlock();
              sfx.click();
              void import('../net/lobby').then((m) => m.hostLobby(stage, again));
            },
          },
          'Host a game',
        ),
        h(
          'button',
          {
            class: 'btn big ghost',
            id: 'join-wifi',
            onclick: () => {
              sfx.unlock();
              sfx.click();
              void import('../net/lobby').then((m) => m.joinLobby(stage, again));
            },
          },
          'Join a game',
        ),
        h('p', { class: 'muted small' }, 'Everyone must be on the same Wi-Fi network.'),
      ),
      h(
        'div',
        { class: 'howto' },
        h('b', {}, 'How to play'),
        h(
          'p',
          {},
          'Left thumb: move (push to the edge to sprint). PASS: no direction = nearest, direction = that way, pushed to the edge = longest. SHOOT: direction picks the corner, pushed to the edge shoots high.',
        ),
        h(
          'p',
          {},
          'Outside the box the keeper must guess the side; inside the box, side and height; in the six-yard box it always goes in. When they shoot at you: swipe to dive!',
        ),
      ),
    ),
  );
}
