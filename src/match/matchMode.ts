// The 7v7 match screen: drives a Session, draws it, plays sounds, shows the HUD.

import type { Scene, Stage } from '../render/app';
import { MatchScene, type TeamKit } from '../render/matchScene';
import { haptic, sfx } from '../ui/audio';
import { banner, h, hex, root } from '../ui/dom';
import { save, store } from '../ui/save';
import { Controls } from './controls';
import { pauseMenu } from './pauseMenu';
import type { Session } from './session';
import { TACTICS } from './tactics';
import { FIREBALL, type MatchEvent, type Team } from './types';
import type { ViewState } from './view';

export const KITS: [TeamKit, TeamKit] = [
  { color: 0x2f6bff, trim: 0xffffff, shorts: 0x0d1b4d, keeper: 0xffc21a },
  { color: 0xe8364b, trim: 0x1a1a1a, shorts: 0xffffff, keeper: 0x7cff4f },
];

export class MatchMode implements Scene {
  readonly scene: MatchScene;
  private readonly controls: Controls;
  private readonly hud: HTMLElement;
  private hudEls: { left: HTMLElement; right: HTMLElement; clock: HTMLElement } | null = null;
  private lastView: ViewState | null = null;
  private lastCharge = -1;
  private screenKey = '';
  private endShown = false;
  private lostShown = false;
  private quitting = false;
  private endPanel: HTMLElement | null = null;
  private menu: HTMLElement | null = null;

  constructor(
    private readonly stage: Stage,
    private readonly session: Session,
    private readonly exit: () => void,
  ) {
    this.scene = new MatchScene(session.myTeam, KITS);
    this.scene.mySlot = session.mySlot;
    this.scene.names = session.names;
    this.controls = new Controls(session.myTeam === 0 ? 1 : -1);
    this.hud = h('div', { class: 'match-hud' });
    root().append(this.controls.el, this.hud);
    window.addEventListener('keydown', this.onKey);
    sfx.ambience(true);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key.toLowerCase() !== 'p') return;
    if (this.menu) this.closeMenu();
    else this.openMenu();
  };

  /** The pause menu: tactics, resume, quit. Against the computer the match stops; on Wi-Fi it goes on. */
  private openMenu(): void {
    if (this.menu || this.endShown || this.quitting) return;
    sfx.click();
    this.session.paused = this.session.canPause;
    const me = this.session.myTeam;
    this.menu = pauseMenu({
      paused: this.session.canPause,
      current: this.lastView?.tactics[me] ?? 'balanced',
      color: KITS[me].color,
      onPick: (t) => {
        sfx.click();
        haptic(10);
        this.session.setTactic(t);
        save.tactic = t;
        store(save);
      },
      onResume: () => this.closeMenu(),
      onQuit: () => this.quit(),
    });
    root().appendChild(this.menu);
  }

  private closeMenu(): void {
    if (!this.menu) return;
    sfx.click();
    this.menu.remove();
    this.menu = null;
    this.session.paused = false;
    const t = this.lastView ? TACTICS[this.lastView.tactics[this.session.myTeam]] : null;
    if (t) void banner(t.name.toUpperCase(), 'neutral', 'Tactics', 700);
  }

  get root() {
    return this.scene.root;
  }

  update(dt: number): void {
    const { view, events } = this.session.update(dt, this.controls.read());
    if (view) {
      this.scene.view = view;
      for (const e of events) this.onEvent(e, view);
      const d = view.duel;
      const defending = view.state === 'duel' && !!d && d.keeperHuman && d.team !== this.session.myTeam && d.dive === -2;
      this.controls.setDiving(defending, d ? (d.window - d.tick) / 60 : 0);
      // Charge ring on the SHOOT button follows my player's charge.
      const mine = view.players.find((p) => p.human === this.session.mySlot);
      const charge = mine ? mine.charge : -1;
      this.controls.setCharge(charge);
      this.controls.setPassCharge(mine ? mine.passCharge : -1);
      const myKickoff = view.state === 'kickoff' && view.ball.owner >= 0 && view.players[view.ball.owner]?.human === this.session.mySlot;
      this.controls.setKickoff(myKickoff);
      if (charge >= 0.999 && this.lastCharge < 0.999) {
        sfx.chargeFull();
        haptic(25);
      }
      this.lastCharge = charge;
      this.renderHud(view);
      this.fitScreen();
      if (view.state === 'ended' && !this.endShown) this.showEnd(view);
      if (view.state !== 'ended' && this.endShown) this.hideEnd();
      this.lastView = view;
    }
    if (this.session.lost && !this.lostShown) {
      this.lostShown = true;
      void banner('Connection lost', 'bad', this.session.lost, 2500).then(() => this.quit());
    }
    // Paused: the picture holds still too.
    this.scene.update(this.session.paused ? 0 : dt);
  }

  private onEvent(e: MatchEvent, v: ViewState): void {
    const me = this.session.myTeam;
    switch (e.type) {
      case 'kick':
        sfx.kick(Math.min(1, e.power / 26));
        break;
      case 'whistle':
        sfx.whistle(e.long);
        break;
      case 'steal':
        sfx.click();
        break;
      case 'shot':
        this.scene.shake(4);
        if (v.duel && v.duel.power >= FIREBALL) {
          sfx.fireball();
          this.scene.shake(8);
        }
        break;
      case 'goal': {
        const ours = e.team === me;
        if (ours) sfx.goal();
        else sfx.miss();
        this.scene.burst(v.ball.x, v.ball.y, ours ? 0xc6ff00 : 0xff4d6d, 60);
        this.scene.confetti(KITS[e.team].color);
        this.scene.netRipple(e.team, v.ball.x);
        this.scene.shake(12);
        haptic(ours ? 40 : 15);
        void banner(ours ? 'GOAL!' : 'GOAL', ours ? 'good' : 'bad', `${v.score[0]} – ${v.score[1]}`, 1800);
        break;
      }
      case 'save': {
        const ours = this.lastView ? v.players[e.by]?.team === me : false;
        sfx.save();
        this.scene.burst(v.ball.x, v.ball.y, 0xffffff, 30);
        void banner(ours ? 'WHAT A SAVE!' : 'SAVED', ours ? 'good' : 'bad', '', 1100);
        break;
      }
      case 'bounce':
        break;
      default:
        break;
    }
  }

  /** Builds the HUD once; later frames only change its text, so the quit button never moves under a finger. */
  private buildHud(): { left: HTMLElement; right: HTMLElement; clock: HTMLElement } {
    const me = this.session.myTeam;
    const side = (t: Team, align: string) =>
      h(
        'div',
        { class: `mside ${align}`, style: `--team:${hex(KITS[t].color)}` },
        h('span', { class: 'mbadge' }),
        h('span', { class: 'mname' }, t === me ? 'YOU' : this.session.names.size > 1 ? 'AWAY' : 'CPU'),
      );
    const els = { left: h('span', {}, '0'), right: h('span', {}, '0'), clock: h('div', { class: 'mclock glass' }) };
    // My team is always shown on the left (it attacks to the right).
    const pause = h('button', { class: 'icon-btn glass', id: 'pause', title: 'Pause · tactics', onclick: () => this.openMenu() });
    pause.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
    this.hud.replaceChildren(
      pause,
      h(
        'div',
        { class: 'mboard glass' },
        side(me, 'l'),
        h('div', { class: 'mscore' }, els.left, h('i', {}, ''), els.right),
        side((1 - me) as Team, 'r'),
      ),
      els.clock,
    );
    return els;
  }

  /** Tells the scene which part of it is on screen and where the HUD ends (when the layout changes). */
  private fitScreen(): void {
    const key = `${this.stage.scale}:${this.stage.offsetX}:${this.stage.offsetY}`;
    if (key === this.screenKey) return;
    this.screenKey = key;
    const hudBottom = this.hud.getBoundingClientRect().bottom;
    this.scene.screen = { ...this.stage.visibleRect(), top: this.stage.toView(0, hudBottom).y };
  }

  private renderHud(v: ViewState): void {
    this.hudEls ??= this.buildHud();
    const secs = Math.ceil(v.clock);
    const clock = v.state === 'ended' ? 'FT' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const me = this.session.myTeam;
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text;
    };
    set(this.hudEls.left, String(v.score[me]));
    set(this.hudEls.right, String(v.score[1 - me]));
    set(this.hudEls.clock, clock);
    this.hudEls.clock.classList.toggle('late', secs <= 10 && v.state !== 'ended');
  }

  private showEnd(v: ViewState): void {
    // On Wi-Fi the clock runs on behind the menu: full time closes it.
    this.menu?.remove();
    this.menu = null;
    this.endShown = true;
    const me = this.session.myTeam;
    const mine = v.score[me];
    const theirs = v.score[1 - me];
    const title = mine > theirs ? 'YOU WIN!' : mine < theirs ? 'YOU LOSE' : 'DRAW';
    if (mine > theirs) sfx.fanfare();
    else if (mine < theirs) sfx.lose();
    this.endPanel = h(
      'div',
      { class: 'panel end-panel' },
      h('h3', {}, 'FULL TIME'),
      h('div', { class: 'ft-score' }, `${v.score[0]} – ${v.score[1]}`),
      h('p', {}, title),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => this.quit() }, 'Menu'),
        this.session.canRestart
          ? h(
              'button',
              {
                class: 'btn',
                id: 'rematch',
                onclick: () => {
                  sfx.click();
                  this.session.restart();
                },
              },
              'Rematch',
            )
          : null,
      ),
    );
    root().appendChild(this.endPanel);
  }

  private hideEnd(): void {
    this.endShown = false;
    this.endPanel?.remove();
    this.endPanel = null;
  }

  private quit(): void {
    // Once only: e.g. the player taps ✕ while the "Connection lost" banner is about to leave too.
    if (this.quitting) return;
    this.quitting = true;
    sfx.click();
    this.exit();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.session.close();
    this.controls.destroy();
    this.hud.remove();
    this.menu?.remove();
    this.endPanel?.remove();
    sfx.ambience(false);
    this.scene.destroy();
  }

  /** For tests. */
  get view(): ViewState | null {
    return this.lastView;
  }

  get stageRef(): Stage {
    return this.stage;
  }
}
