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
  const go = (fn: () => void) => () => {
    sfx.unlock();
    sfx.click();
    fn();
  };
  showScreen(
    h(
      'div',
      { class: 'menu match-menu' },
      h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: back }, '←'), h('h2', {}, '7v7 MATCH'), h('span', {})),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'col' },
            h('div', { class: 'section-title' }, '🤖 VS COMPUTER'),
            h('div', { class: 'chips' }, ...chips),
            h(
              'button',
              { class: 'btn big', id: 'play-cpu', onclick: go(() => playSession(stage, new LocalSession(difficulty), again)) },
              'Kick off',
            ),
          ),
        ),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'col' },
            h('div', { class: 'section-title' }, '📶 WI-FI WITH FRIENDS'),
            h(
              'button',
              {
                class: 'btn big alt',
                id: 'host-wifi',
                onclick: go(() => void import('../net/lobby').then((m) => m.hostLobby(stage, again))),
              },
              'Host a game',
            ),
            h(
              'button',
              {
                class: 'btn big ghost',
                id: 'join-wifi',
                onclick: go(() => void import('../net/lobby').then((m) => m.joinLobby(stage, again))),
              },
              'Join a game',
            ),
            h('p', { class: 'muted small' }, 'Everyone must be on the same Wi-Fi network.'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'howto' },
        h(
          'div',
          {},
          h('b', {}, 'Attack'),
          h(
            'p',
            {},
            'Left thumb moves, past the edge sprints. PASS: tap = to the nearest teammate the stick points at, hold until the ring is full = long ball to the far one (nobody can touch it until it lands). SHOOT: hold to power up, release to shoot (full power = 🔥 fireball). Aim with the stick: up / down = that post, centred = middle, at the edge = high.',
          ),
        ),
        h(
          'div',
          {},
          h('b', {}, 'Defend'),
          h(
            'p',
            {},
            'Touch the man on the ball to win it: the ball moves away with you. PASS: tap = switch to the player nearest the ball, hold = chase the ball. When they shoot: push the stick toward the ball and tap a button to dive.',
          ),
        ),
      ),
    ),
  );
}
