// Wi-Fi lobby screens: host a game, or find and join one on the same network.

import { KITS } from '../match/matchMode';
import { playSession } from '../match/matchMenu';
import type { Team } from '../match/types';
import type { Stage } from '../render/app';
import { sfx } from '../ui/audio';
import { banner, h, hex, showScreen } from '../ui/dom';
import { save, store } from '../ui/save';
import { LanClient } from './client';
import { devRelayBackend } from './devRelay';
import { LanHost } from './host';
import { isNativeApp, nativeLanBackend } from './nativeLan';
import type { LobbyPlayer } from './protocol';
import type { GameInfo, NetBackend } from './transport';

async function backend(): Promise<NetBackend | null> {
  if (isNativeApp()) return nativeLanBackend();
  return devRelayBackend();
}

function noWifiScreen(back: () => void): void {
  showScreen(
    h(
      'div',
      { class: 'menu' },
      h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: back }, '←'), h('h2', {}, 'WI-FI PLAY'), h('span', {})),
      h('div', { class: 'end-icon' }, '📶'),
      h(
        'p',
        { class: 'tagline' },
        'Wi-Fi play works in the Spot Kick app on iPhone and Android: phones on the same Wi-Fi find each other automatically.',
      ),
      h(
        'p',
        { class: 'muted small' },
        'Playing in a browser? Start the local relay with "npm run lan-dev" on one computer, then open the game on the same network.',
      ),
    ),
  );
}

/** Asks for a display name once, then remembers it. */
function withName(next: (name: string) => void, back: () => void): void {
  if (save.playerName) return next(save.playerName);
  const input = h('input', { class: 'name-input', id: 'name', maxlength: '14', placeholder: 'Your name' } as never) as HTMLInputElement;
  const go = () => {
    const name = input.value.trim() || `Player${Math.floor(Math.random() * 900 + 100)}`;
    save.playerName = name;
    store(save);
    sfx.click();
    next(name);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  showScreen(
    h(
      'div',
      { class: 'menu' },
      h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: back }, '←'), h('h2', {}, 'YOUR NAME'), h('span', {})),
      h('p', { class: 'tagline' }, 'Friends will see this name above your player.'),
      h('div', { class: 'col' }, input, h('button', { class: 'btn big', id: 'name-ok', onclick: go }, 'Continue')),
    ),
  );
  setTimeout(() => input.focus(), 50);
}

function teamColumns(players: LobbyPlayer[], me: number, onMove: ((p: LobbyPlayer) => void) | null): HTMLElement {
  const col = (team: Team) =>
    h(
      'div',
      { class: 'team-col', style: `--team:${hex(KITS[team].color)}` },
      h('div', { class: 'team-col-head' }, team === 0 ? 'BLUE' : 'RED'),
      ...players
        .filter((p) => p.team === team)
        .map((p) =>
          h(
            'div',
            { class: 'lobby-player' + (p.slot === me ? ' me' : '') },
            h('span', {}, p.slot === 0 ? `👑 ${p.name}` : p.name),
            onMove ? h('button', { class: 'move', title: 'Switch team', onclick: () => onMove(p) }, '⇄') : null,
          ),
        ),
      h('div', { class: 'muted small' }, `+ computer players`),
    );
  return h('div', { class: 'teams' }, col(0), col(1));
}

export async function hostLobby(stage: Stage, back: () => void): Promise<void> {
  const be = await backend();
  if (!be) return noWifiScreen(back);
  withName(async (name) => {
    const host = new LanHost(be.host(), name);
    try {
      await host.open();
    } catch (e) {
      void banner('Could not start Wi-Fi', 'bad', String((e as Error).message ?? e), 2500);
      return back();
    }
    let duration = 180;
    const leave = () => {
      host.close();
      back();
    };
    const render = () => {
      if (host.started) return;
      const chips = [
        [120, '2 min'],
        [180, '3 min'],
        [300, '5 min'],
      ].map(([sec, label]) =>
        h(
          'button',
          {
            class: 'chip-btn' + (sec === duration ? ' on' : ''),
            onclick: () => {
              duration = sec as number;
              render();
            },
          },
          String(label),
        ),
      );
      showScreen(
        h(
          'div',
          { class: 'menu lobby' },
          h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: leave }, '✕'), h('h2', {}, 'YOUR GAME'), h('span', {})),
          h('p', { class: 'tagline' }, `Friends on this Wi-Fi tap “Join a game” and pick “${name}”.`),
          teamColumns(host.players, 0, (p) => host.setTeam(p.slot, p.team === 0 ? 1 : 0)),
          h(
            'div',
            { class: 'col' },
            h('div', { class: 'chips' }, ...chips),
            h(
              'button',
              { class: 'btn big', id: 'start-match', onclick: () => startMatch() },
              `Start match (${host.players.length} player${host.players.length > 1 ? 's' : ''})`,
            ),
          ),
          h('p', { class: 'muted small' }, 'Empty spots are filled by computer players.'),
        ),
      );
    };
    const startMatch = () => {
      sfx.click();
      host.start(duration);
      // Leaving the match ends the hosted game (rematches happen from the full-time screen).
      playSession(stage, host, back);
    };
    host.onLobby = () => render();
    render();
  }, back);
}

export async function joinLobby(stage: Stage, back: () => void): Promise<void> {
  const be = await backend();
  if (!be) return noWifiScreen(back);
  withName(async (name) => {
    const finder = be.client();
    let games: GameInfo[] = [];
    const list = h('div', { class: 'col game-list' });
    const renderList = () => {
      list.replaceChildren(
        ...(games.length
          ? games.map((g) => h('button', { class: 'btn big ghost game', onclick: () => void join(g) }, `⚽ ${g.name}`))
          : [h('p', { class: 'muted searching' }, 'Looking for games on this Wi-Fi…')]),
      );
    };
    let stopFinding: () => void = () => {};
    const leave = () => {
      stopFinding();
      back();
    };
    showScreen(
      h(
        'div',
        { class: 'menu lobby' },
        h('div', { class: 'map-head' }, h('button', { class: 'icon-btn', onclick: leave }, '←'), h('h2', {}, 'JOIN A GAME'), h('span', {})),
        h('p', { class: 'tagline' }, 'Ask a friend to tap “Host a game”.'),
        list,
      ),
    );
    renderList();
    try {
      let shown = '';
      stopFinding = await finder.discover((g) => {
        // Only rebuild when the list changes, so a button never vanishes under a finger.
        const key = g.map((x) => `${x.id}:${x.name}`).join('|');
        if (key === shown) return;
        shown = key;
        games = g;
        renderList();
      });
    } catch {
      void banner('Wi-Fi search failed', 'bad', 'Check that Wi-Fi is on', 2500);
    }

    const join = async (game: GameInfo) => {
      sfx.click();
      stopFinding();
      const client = new LanClient(be.client(), name);
      const leaveLobby = () => {
        client.close();
        back();
      };
      const render = () => {
        if (client.started) return;
        showScreen(
          h(
            'div',
            { class: 'menu lobby' },
            h(
              'div',
              { class: 'map-head' },
              h('button', { class: 'icon-btn', onclick: leaveLobby }, '✕'),
              h('h2', {}, client.hostName ? `${client.hostName.toUpperCase()}'S GAME` : 'LOBBY'),
              h('span', {}),
            ),
            teamColumns(client.players, client.mySlot, null),
            h(
              'div',
              { class: 'col' },
              h(
                'button',
                { class: 'btn big ghost', id: 'switch-team', onclick: () => client.setTeam(client.myTeam === 0 ? 1 : 0) },
                'Switch team',
              ),
            ),
            h('p', { class: 'muted waiting' }, 'Waiting for the host to start…'),
          ),
        );
      };
      client.onLobby = () => render();
      client.onStart = () => playSession(stage, client, back);
      client.onBye = (reason) => {
        if (!client.started) {
          void banner('Left the game', 'neutral', reason, 2000);
          back();
        }
      };
      try {
        await client.join(game);
        render();
      } catch (e) {
        void banner('Could not join', 'bad', String((e as Error).message ?? e), 2000);
        back();
      }
    };
  }, back);
}
