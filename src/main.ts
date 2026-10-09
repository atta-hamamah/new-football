import { PenaltyMode } from './penalty/penaltyMode';
import { Stage } from './render/app';
import { STAGES } from './run/run';
import { sfx } from './ui/audio';
import { h, showScreen } from './ui/dom';
import { save, store, todayKey } from './ui/save';
import './ui/style.css';

const stage = new Stage();
let penalty: PenaltyMode | null = null;

function backdrop(): PenaltyMode {
  // The stadium stays visible behind menus.
  penalty = new PenaltyMode(stage, showMenu);
  stage.show(penalty);
  penalty.scene.keeperIdle(null);
  return penalty;
}

function soundButton(): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', id: 'sound', title: 'Sound' }, save.muted ? '🔇' : '🔊');
  b.addEventListener('click', () => {
    sfx.unlock();
    save.muted = !save.muted;
    sfx.setMuted(save.muted);
    store(save);
    b.textContent = save.muted ? '🔇' : '🔊';
  });
  return b;
}

export function showMenu(): void {
  backdrop();
  const d = save.daily?.date === todayKey() ? save.daily : null;
  const best = save.bestWins >= STAGES.length ? '🏆 Champion' : save.bestWins > 0 ? `Best: ${STAGES[save.bestWins].name}` : '';
  showScreen(
    h(
      'div',
      { class: 'menu' },
      h('div', { class: 'menu-top' }, soundButton()),
      h('div', { class: 'logo' }, h('div', { class: 'logo-ball' }, '⚽'), h('h1', {}, 'SPOT', h('br'), 'KICK')),
      h('p', { class: 'tagline' }, 'Read the keeper. Pick your corner. Win the cup.'),
      h(
        'div',
        { class: 'col' },
        h(
          'button',
          {
            class: 'btn big',
            id: 'play-run',
            onclick: () => {
              sfx.unlock();
              sfx.click();
              backdrop().start(false);
            },
          },
          '🥅 Penalty Run',
        ),
        h(
          'button',
          {
            class: 'btn big alt',
            id: 'play-daily',
            disabled: Boolean(d),
            onclick: () => {
              sfx.unlock();
              sfx.click();
              backdrop().start(true);
            },
          },
          d ? `📅 Daily done · ${d.results.map((w) => (w ? '🟩' : '🟥')).join('')}` : '📅 Daily Run',
        ),
        h(
          'button',
          {
            class: 'btn big ghost',
            id: 'play-match',
            onclick: () => {
              sfx.unlock();
              sfx.click();
              void import('./match/matchMenu').then((m) => m.showMatchMenu(stage, showMenu));
            },
          },
          '⚽ 6v6 Match',
        ),
      ),
      h(
        'p',
        { class: 'muted small stats' },
        [best, save.titles ? `${save.titles} title${save.titles > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '),
      ),
    ),
  );
}

async function boot(): Promise<void> {
  await stage.init(document.getElementById('stage')!);
  sfx.setMuted(save.muted);
  showMenu();
}

void boot();

// Hook for automated tests and debugging.
declare global {
  interface Window {
    __game: unknown;
  }
}
window.__game = {
  get penalty() {
    return penalty;
  },
  stage,
};
