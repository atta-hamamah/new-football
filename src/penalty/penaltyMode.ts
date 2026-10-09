// Penalty Run game flow: map -> shootout (shoot / save, alternating) -> upgrade pick -> ...

import { keeperWeights } from '../duel/ai';
import { swayAmplitude, swayOffset } from '../duel/aim';
import { GOAL_SCALE } from '../render/projection';
import { type Point, ZONE_NAMES, zoneIndex } from '../duel/goal';
import { flightTime, type Outcome } from '../duel/resolve';
import type { Scene, Stage } from '../render/app';
import { PenaltyScene } from '../render/penaltyScene';
import { makeSave, prepareSave, prepareShot, takeShot } from '../run/kick';
import { Run, STAGES } from '../run/run';
import { Shootout } from '../run/shootout';
import { upgradeById } from '../run/upgrades';
import { haptic, sfx } from '../ui/audio';
import { banner, h, hex, root, showScreen } from '../ui/dom';
import { save, store, todayKey } from '../ui/save';

export const YOU_COLOR = 0x06d6a0;
const AIM_GAIN = 1.25;
const MIN_HOLD = 0.2;

export type Phase = 'map' | 'intro' | 'aim' | 'flight' | 'runup' | 'react' | 'result' | 'pick' | 'end';

export class PenaltyMode implements Scene {
  readonly scene = new PenaltyScene();
  phase: Phase = 'map';
  run!: Run;
  daily = false;
  shootout = new Shootout();

  private hud: HTMLElement | null = null;
  private hint: HTMLElement | null = null;

  // Aiming
  private aim: Point = { x: 0, y: 1.1 };
  private aimShown: Point = { x: 0, y: 1.1 };
  private aimAmp = 0;
  private holding = false;
  private holdT = 0;
  private swayT = 0;
  private noSway = false;
  private lastPtr: { x: number; y: number } | null = null;
  private onRelease: ((p: Point) => void) | null = null;

  // Diving
  private swipeStart: { x: number; y: number } | null = null;
  private onDive: ((zone: number | null) => void) | null = null;

  private readonly listeners: [string, EventListener][] = [];

  constructor(
    private readonly stage: Stage,
    private readonly exit: () => void,
  ) {
    this.bindInput();
  }

  get root() {
    return this.scene.root;
  }

  // --- Scene ------------------------------------------------------------------------------

  update(dt: number): void {
    if (this.phase === 'aim') {
      if (this.holding) this.holdT += dt;
      this.swayT += dt;
      this.aimAmp = this.noSway ? 0 : swayAmplitude(this.aim, this.run.stats.sway, this.holdT);
      const off = swayOffset(this.swayT, this.aimAmp);
      this.aimShown = { x: this.aim.x + off.x, y: this.aim.y + off.y };
      this.scene.showReticle(this.aimShown, this.aimAmp);
      sfx.tension(Math.min(1, 0.3 + this.holdT * 0.2));
    }
    this.scene.update(dt);
  }

  destroy(): void {
    for (const [type, fn] of this.listeners) this.stage.canvas.removeEventListener(type, fn);
    window.removeEventListener('keydown', this.onKey);
    this.hud?.remove();
    this.hint?.remove();
    sfx.ambience(false);
    this.scene.destroy();
  }

  // --- input -------------------------------------------------------------------------------

  private listen(type: string, fn: (e: PointerEvent) => void): void {
    const l = fn as EventListener;
    this.stage.canvas.addEventListener(type, l);
    this.listeners.push([type, l]);
  }

  private bindInput(): void {
    this.listen('pointerdown', (e) => {
      sfx.unlock();
      const p = this.stage.toView(e.clientX, e.clientY);
      if (this.phase === 'aim') {
        this.stage.canvas.setPointerCapture(e.pointerId);
        this.holding = true;
        this.lastPtr = { x: e.clientX, y: e.clientY };
      } else if ((this.phase === 'runup' || this.phase === 'react') && this.onDive) {
        this.swipeStart = p;
      }
    });
    this.listen('pointermove', (e) => {
      if (this.phase === 'aim' && this.holding && this.lastPtr) {
        const k = AIM_GAIN / (this.stage.pxPerUnit * GOAL_SCALE);
        this.aim = {
          x: Math.max(-4.6, Math.min(4.6, this.aim.x + (e.clientX - this.lastPtr.x) * k)),
          y: Math.max(0.12, Math.min(3.2, this.aim.y - (e.clientY - this.lastPtr.y) * k)),
        };
        this.lastPtr = { x: e.clientX, y: e.clientY };
      } else if (this.swipeStart && this.onDive) {
        const p = this.stage.toView(e.clientX, e.clientY);
        const dx = p.x - this.swipeStart.x;
        const dy = p.y - this.swipeStart.y;
        if (dx * dx + dy * dy > 45 * 45) this.finishSwipe(dx, dy);
      }
    });
    const up = (e: PointerEvent) => {
      if (this.phase === 'aim' && this.holding) {
        this.holding = false;
        this.lastPtr = null;
        if (this.holdT >= MIN_HOLD) this.onRelease?.(this.aimShown);
      } else if (this.swipeStart && this.onDive) {
        const p = this.stage.toView(e.clientX, e.clientY);
        this.finishSwipe(p.x - this.swipeStart.x, p.y - this.swipeStart.y);
      }
    };
    this.listen('pointerup', up);
    this.listen('pointercancel', () => {
      this.holding = false;
      this.swipeStart = null;
    });
    window.addEventListener('keydown', this.onKey);
  }

  /** Desktop: arrow keys / QWE-ASD to dive. */
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.onDive) return;
    const map: Record<string, number | null> = {
      q: 3,
      w: 4,
      e: 5,
      a: 0,
      s: 1,
      d: 2,
      ArrowLeft: 0,
      ArrowRight: 2,
      ArrowUp: 4,
      ArrowDown: 1,
      ' ': null,
    };
    if (e.key in map) this.onDive(map[e.key]);
  };

  /** Swipe direction -> zone (screen left = goal left as seen from behind the ball). */
  private finishSwipe(dx: number, dy: number): void {
    this.swipeStart = null;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 20) {
      this.onDive?.(null);
      return;
    }
    const col = dx > 0.4 * len ? 1 : dx < -0.4 * len ? -1 : 0;
    const row = dy < -0.35 * len ? 1 : 0;
    this.onDive?.(zoneIndex({ col, row }));
  }

  // --- flow ---------------------------------------------------------------------------------

  start(daily: boolean, seed?: number): void {
    this.daily = daily;
    this.run = daily ? Run.daily(new Date()) : new Run(seed ?? (Math.random() * 2 ** 32) >>> 0);
    save.runs++;
    store(save);
    this.scene.resetKick();
    this.scene.keeperIdle(null);
    this.showMap();
  }

  showMap(note = ''): void {
    this.phase = 'map';
    this.hideHud();
    const run = this.run;
    const opp = run.opponent;
    const ladder = h(
      'ol',
      { class: 'ladder' },
      ...STAGES.map((s, i) =>
        h(
          'li',
          { class: i < run.stage ? 'done' : i === run.stage ? 'current' : '' },
          h('span', { class: 'dot' }, i < run.stage ? '✓' : s.boss ? '👑' : String(i + 1)),
          h('span', {}, s.name),
        ),
      ),
    );
    const kit = run.upgrades.length
      ? h(
          'div',
          { class: 'kit' },
          ...run.upgrades.map((id) => {
            const u = upgradeById(id);
            return h('span', { class: 'chip', title: `${u.name}: ${u.desc}` }, `${u.icon} ${u.name}`);
          }),
        )
      : h('p', { class: 'muted small' }, 'Win shootouts to earn upgrades.');
    showScreen(
      h(
        'div',
        { class: 'map' },
        h(
          'div',
          { class: 'map-head' },
          h('button', { class: 'icon-btn', onclick: () => this.quit() }, '✕'),
          h('h2', {}, this.daily ? `DAILY RUN · ${todayKey()}` : 'PENALTY RUN'),
          h('span', { class: 'lives' }, run.stats.lives > 0 ? `❤️ ×${run.stats.lives}` : ''),
        ),
        h(
          'div',
          { class: 'split' },
          h('div', {}, ladder),
          h(
            'div',
            {},
            note ? h('p', { class: 'note' }, note) : null,
            h(
              'div',
              { class: 'opp-card', style: `--team:${hex(opp.color)}` },
              h('div', { class: 'opp-label' }, `${run.stageInfo.boss ? 'BOSS · ' : ''}${run.stageInfo.name.toUpperCase()}`),
              h('div', { class: 'opp-name' }, h('span', { class: 'swatch' }), opp.name),
              h('div', { class: 'opp-keeper' }, `🧤 ${opp.keeper.name}`),
              h('div', { class: 'opp-trait' }, opp.keeper.trait),
            ),
            kit,
            h('button', { class: 'btn big', id: 'kickoff', onclick: () => void this.playMatch() }, 'Kick off'),
          ),
        ),
      ),
    );
  }

  private quit(): void {
    sfx.click();
    showScreen(null);
    this.exit();
  }

  private showHud(): void {
    this.hud?.remove();
    this.hud = h('div', { class: 'hud' });
    root().appendChild(this.hud);
    this.hint = h('div', { class: 'hint hidden' });
    root().appendChild(this.hint);
    this.renderHud();
  }

  private hideHud(): void {
    this.hud?.remove();
    this.hint?.remove();
    this.hud = this.hint = null;
  }

  private renderHud(): void {
    if (!this.hud) return;
    const so = this.shootout;
    const dots = (side: 'you' | 'them') => {
      const kicks = so.kicks.filter((k) => k.side === side);
      const n = Math.max(5, kicks.length + (so.next === side ? 1 : 0));
      return h(
        'div',
        { class: 'dots' },
        ...Array.from({ length: n }, (_, i) => h('span', { class: i < kicks.length ? (kicks[i].scored ? 'hit' : 'miss') : '' })),
      );
    };
    const { you, them } = so.score;
    this.hud.replaceChildren(
      h(
        'div',
        { class: 'board' },
        h('div', { class: 'team', style: `--team:${hex(YOU_COLOR)}` }, h('span', { class: 'team-name' }, 'YOU'), dots('you')),
        h(
          'div',
          { class: 'score' },
          `${you} – ${them}`,
          h('div', { class: 'stage-name' }, so.suddenDeath ? 'SUDDEN DEATH' : this.run.stageInfo.name),
        ),
        h(
          'div',
          { class: 'team right', style: `--team:${hex(this.run.opponent.color)}` },
          dots('them'),
          h('span', { class: 'team-name' }, this.run.opponent.name.toUpperCase()),
        ),
      ),
    );
  }

  private setHint(text: string | null): void {
    if (!this.hint) return;
    this.hint.textContent = text ?? '';
    this.hint.classList.toggle('hidden', !text);
  }

  async playMatch(): Promise<void> {
    sfx.unlock();
    sfx.click();
    showScreen(null);
    this.shootout = new Shootout();
    this.showHud();
    sfx.ambience(true);
    sfx.whistle();
    const so = this.shootout;
    let kick = 0;
    let retakes = this.run.stats.retakes;
    let streak = false;
    while (so.next) {
      if (so.next === 'you') {
        let out = await this.playerShot(streak);
        if (out !== 'goal' && retakes > 0 && (await this.askRetake())) {
          retakes--;
          out = await this.playerShot(false);
        }
        streak = this.run.stats.hotStreak && out === 'goal';
        so.record('you', out === 'goal');
      } else {
        const out = await this.playerSave(kick++);
        so.record('them', out === 'goal');
      }
      this.renderHud();
    }
    await this.endMatch(so.winner === 'you');
  }

  private async playerShot(streak: boolean): Promise<Outcome> {
    const run = this.run;
    const scene = this.scene;
    const prep = prepareShot(run);
    scene.resetKick();
    scene.setKeeperKit(run.opponent.color);
    scene.keeperIdle(prep.tell);
    if (run.stats.scout) scene.showHeat(keeperWeights(run.opponent.keeper, run.history));
    this.aim = { x: 0, y: 1.1 };
    this.aimShown = { ...this.aim };
    this.holdT = 0;
    this.swayT = 0;
    this.noSway = streak;
    this.setHint(streak ? '🔥 Hot streak: no wobble!' : 'Drag to aim · release to shoot');
    this.phase = 'aim';
    const point = await new Promise<Point>((res) => (this.onRelease = res));
    this.onRelease = null;
    this.setHint(null);
    scene.showReticle(null, 0);
    this.phase = 'flight';

    const r = takeShot(run, prep, point);
    sfx.kick();
    haptic(15);
    scene.timeScale = 0.55;
    void scene.dive(r.outcome === 'saved' ? r.shot : r.keeper, r.flightTime * 0.95);
    await scene.flightTo(r.shot, r.flightTime);
    scene.timeScale = 1;
    scene.followThrough(r.shot, r.outcome);
    await this.showOutcome(r.outcome, true, r.shot);
    return r.outcome;
  }

  private async playerSave(kick: number): Promise<Outcome> {
    const run = this.run;
    const scene = this.scene;
    const ai = prepareSave(run, kick);
    scene.resetKick();
    scene.setKeeperKit(YOU_COLOR);
    scene.keeperIdle(null);
    this.setHint('Read his run-up · swipe to dive');
    this.phase = 'runup';
    let chosen: number | null | undefined;
    let decided: () => void = () => {};
    const decision = new Promise<void>((res) => (decided = res));
    this.onDive = (z) => {
      if (chosen !== undefined) return;
      chosen = z;
      decided();
    };
    await scene.wait(0.35);
    await scene.runUp(run.opponent.color, 2 + (kick % 9), ai.tell, 1.25);

    // Strike!
    this.phase = 'react';
    sfx.kick();
    scene.fadeShooter();
    const t = flightTime(ai.shot.speed);
    const strikeClock = scene.gameClock;
    scene.timeScale = run.stats.slowmo;
    const arrived = scene.flightTo(ai.shot, t);
    if (chosen === undefined) {
      this.setHint('DIVE!');
      await Promise.race([decision, scene.wait(run.stats.reactionWindow, true)]);
    }
    this.onDive = null;
    this.setHint(null);
    const zone = chosen ?? null;
    const res = makeSave(run, ai, zone);
    if (zone !== null) {
      sfx.dive();
      const left = Math.max(0.08, t - (scene.gameClock - strikeClock));
      void scene.dive(res.outcome === 'saved' ? ai.shot : res.keeper, left);
    }
    await arrived;
    scene.timeScale = 1;
    scene.followThrough(ai.shot, res.outcome);
    await this.showOutcome(res.outcome, false, ai.shot, zone);
    return res.outcome;
  }

  private async showOutcome(o: Outcome, mine: boolean, at: Point, zone?: number | null): Promise<void> {
    this.phase = 'result';
    const scene = this.scene;
    if (mine) {
      if (o === 'goal') {
        sfx.goal();
        scene.confetti(YOU_COLOR);
        scene.cheer();
        scene.shake(10);
        haptic(30);
        await banner('GOAL!', 'good');
      } else {
        if (o === 'saved') {
          sfx.save();
          scene.burst(at, 0xffffff);
          scene.shake(6);
        } else if (o === 'post') {
          sfx.post();
          scene.shake(8);
        } else sfx.miss();
        await banner({ saved: 'SAVED', post: 'OFF THE POST!', wide: 'WIDE!', over: 'OVER THE BAR!' }[o], 'bad');
      }
    } else if (o === 'goal') {
      sfx.miss();
      scene.shake(4);
      const sub = zone === undefined || zone === null ? 'You stayed put' : `You went ${ZONE_NAMES[zone]}`;
      await banner('THEY SCORE', 'bad', sub);
    } else {
      if (o === 'saved') {
        sfx.save();
        scene.burst(at, YOU_COLOR);
        scene.cheer();
        scene.shake(10);
        haptic(30);
      } else if (o === 'post') sfx.post();
      else sfx.goal();
      await banner(o === 'saved' ? 'WHAT A SAVE!' : o === 'post' ? 'OFF THE POST!' : 'HE MISSED!', 'good');
    }
  }

  private askRetake(): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        el.remove();
        resolve(v);
      };
      const el = h(
        'div',
        { class: 'panel retake' },
        h('h3', {}, '📺 VAR REVIEW'),
        h('p', {}, 'Encroachment! Retake the penalty?'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => done(false) }, 'No'),
          h('button', { class: 'btn', id: 'retake-yes', onclick: () => done(true) }, 'Retake'),
        ),
      );
      const timer = setTimeout(() => done(false), 5000);
      root().appendChild(el);
    });
  }

  private async endMatch(won: boolean): Promise<void> {
    const { you, them } = this.shootout.score;
    sfx.whistle(true);
    this.phase = 'result';
    if (won) {
      sfx.fanfare();
      this.scene.confetti(YOU_COLOR);
    } else sfx.lose();
    await banner(won ? 'YOU WIN!' : 'KNOCKED OUT', won ? 'good' : 'bad', `${you} – ${them} vs ${this.run.opponent.name}`, 2000);
    sfx.ambience(false);
    const livesBefore = this.run.stats.lives;
    this.run.finishMatch(won);
    if (this.run.status !== 'playing') return this.showEnd();
    if (this.run.pendingOffers) return this.showPick();
    if (this.run.stats.lives < livesBefore) this.showMap('❤️ Second Leg! You get another shot at this round.');
  }

  showPick(): void {
    this.phase = 'pick';
    this.hideHud();
    const offers = this.run.pendingOffers!;
    showScreen(
      h(
        'div',
        { class: 'pick' },
        h('h2', {}, 'CHOOSE AN UPGRADE'),
        h('p', { class: 'muted' }, `Next: ${STAGES[this.run.stage + 1].name}`),
        h(
          'div',
          { class: 'cards' },
          ...offers.map((u) =>
            h(
              'button',
              {
                class: `card ${u.kind} ${u.rarity}`,
                onclick: () => {
                  sfx.card();
                  this.run.pickUpgrade(u.id);
                  this.showMap();
                },
              },
              h('div', { class: 'card-icon' }, u.icon),
              h('div', { class: 'card-name' }, u.name),
              h('div', { class: 'card-desc' }, u.desc),
              h('div', { class: 'card-tag' }, u.rarity === 'rare' ? `★ RARE · ${u.kind}` : u.kind),
            ),
          ),
        ),
      ),
    );
  }

  showEnd(): void {
    this.phase = 'end';
    this.hideHud();
    const run = this.run;
    const champion = run.status === 'champion';
    save.bestWins = Math.max(save.bestWins, run.wins);
    if (champion) save.titles++;
    if (this.daily) save.daily = { date: todayKey(), wins: run.wins, champion, results: [...run.results] };
    store(save);
    const reached = STAGES[Math.min(run.stage, STAGES.length - 1)].name;
    const grid = run.results.map((w) => (w ? '🟩' : '🟥')).join('');
    const shareText = `⚽ Spot Kick${this.daily ? ` · Daily ${todayKey()}` : ''}\n${grid}\n${champion ? '🏆 CHAMPIONS!' : `Knocked out in the ${reached}`}`;
    showScreen(
      h(
        'div',
        { class: 'end' },
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            {},
            h('div', { class: 'end-icon' }, champion ? '🏆' : '🥅'),
            h('h2', {}, champion ? 'CHAMPIONS!' : 'RUN OVER'),
            h('p', {}, champion ? 'You won every shootout. Legendary.' : `Knocked out in the ${reached}.`),
            h('div', { class: 'grid' }, grid),
            h('p', { class: 'muted small' }, `Shootouts won: ${run.wins} · Best ever: ${save.bestWins}`),
          ),
          h(
            'div',
            {},
            h(
              'div',
              { class: 'col' },
              h('button', { class: 'btn', onclick: () => void share(shareText) }, '📤 Share result'),
              this.daily ? null : h('button', { class: 'btn ghost', id: 'again', onclick: () => this.start(false) }, 'Play again'),
              h('button', { class: 'btn ghost', onclick: () => this.quit() }, 'Menu'),
            ),
          ),
        ),
      ),
    );
  }
}

async function share(text: string): Promise<void> {
  sfx.click();
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return;
    }
  } catch {
    // cancelled
  }
  try {
    await navigator.clipboard.writeText(text);
    void banner('Copied!', 'neutral', '', 900);
  } catch {
    void banner('Could not share', 'neutral', '', 900);
  }
}
