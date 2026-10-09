// The penalty duel, seen from behind the spot: night stadium, goal, keeper, ball.
// Pure presentation: the controller tells it what happens and when.

import { BlurFilter, Container, Graphics } from 'pixi.js';
import type { Tell } from '../duel/ai';
import { BALL_R, GOAL_H, GOAL_HALF_W, type Point, ZONES } from '../duel/goal';
import type { Outcome, Shot } from '../duel/resolve';
import type { Scene } from './app';
import { VIEW_W } from './app';
import { KeeperFigure, ShooterFigure } from './figures';
import { CAM_H, FOCAL, GOAL_SCALE, GOAL_Z, HORIZON, project, SPOT_Z } from './projection';

const NET_Z = 17;
const NET_TOP = 2.2;
const SHOOTER_S = 200;
/** Stylised: the taker is drawn smaller than life so he never hides the goal. */
const SHOOTER_SIZE = 0.52;

type Ease = (k: number) => number;
const linear: Ease = (k) => k;
export const easeOut: Ease = (k) => 1 - (1 - k) * (1 - k);
const easeInOut: Ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

interface Tween {
  t: number;
  dur: number;
  real: boolean;
  fn: (k: number) => void;
  ease: Ease;
  done: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
  gravity: number;
}

export class PenaltyScene implements Scene {
  readonly root = new Container();
  /** Game-time multiplier (slow motion). */
  timeScale = 1;
  /** Seconds of game time elapsed (advances slower in slow motion). */
  gameClock = 0;

  private readonly world = new Container();
  private readonly stands = new Container();
  private readonly netG = new Graphics();
  private readonly heatG = new Graphics();
  private readonly frameG = new Graphics();
  private readonly keeper: KeeperFigure;
  private readonly ballShadow = new Graphics();
  private readonly ball = new Container();
  private readonly ballBack = new Container();
  private readonly ballFront = new Container();
  private readonly ballG = new Graphics();
  private readonly reticleG = new Graphics();
  private readonly fxG = new Graphics();
  private shooter: ShooterFigure | null = null;

  private tweens: Tween[] = [];
  private particles: Particle[] = [];
  private shakeAmt = 0;
  private time = 0;
  private ripple: { x: number; y: number; t: number } | null = null;

  // Keeper idle state
  private keeperPos: Point = { x: 0, y: 1.0 };
  private keeperRot = 0;
  private idle: { tell: Tell | null; t: number } | null = null;
  private ballPos = { x: 0, y: BALL_R, z: SPOT_Z };
  private ballSpin = 0;

  constructor() {
    this.keeper = new KeeperFigure(GOAL_SCALE, 0xffbe0b);
    this.buildBackground();
    this.drawNet();
    this.drawFrame();
    this.drawBall();

    const goalLayer = new Container();
    goalLayer.addChild(this.netG, this.heatG, this.ballBack, this.keeper.shadowGraphic, this.keeper.root, this.frameG);
    this.ballFront.addChild(this.ball);
    this.world.addChild(goalLayer, this.ballShadow, this.ballFront, this.reticleG, this.fxG);
    this.fxG.blendMode = 'add';
    this.root.addChild(this.world);
    this.placeKeeper();
    this.placeBall();
  }

  // --- static scenery -------------------------------------------------------------

  private buildBackground(): void {
    const sky = new Graphics();
    sky.rect(-600, -800, VIEW_W + 1200, 1300).fill(0x060a18);
    this.world.addChild(sky);

    // Floodlight glow.
    const glow = new Graphics();
    glow.circle(40, 100, 160).fill({ color: 0xbfd9ff, alpha: 0.35 });
    glow.circle(VIEW_W - 40, 100, 160).fill({ color: 0xbfd9ff, alpha: 0.35 });
    glow.filters = [new BlurFilter({ strength: 40, quality: 4 })];
    glow.blendMode = 'add';

    // Stands with crowd.
    const st = new Graphics();
    st.rect(-600, 170, VIEW_W + 1200, 320).fill(0x0d1430);
    for (let row = 0; row < 9; row++) {
      const y = 195 + row * 30;
      st.rect(-600, y, VIEW_W + 1200, 2).fill({ color: 0x18224a, alpha: 0.8 });
    }
    const palette = [0xffffff, 0xe63946, 0x3a86ff, 0xffbe0b, 0x06d6a0, 0xff006e];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1400; i++) {
      const x = -300 + rand() * (VIEW_W + 600);
      const y = 185 + rand() * 300;
      const far = (y - 180) / 300;
      st.circle(x, y, 1.4 + far * 2.2).fill({ color: palette[Math.floor(rand() * palette.length)], alpha: 0.25 + rand() * 0.45 });
    }
    this.stands.addChild(st);
    this.world.addChild(this.stands, glow);

    // LED advertising boards.
    const boards = new Graphics();
    const by0 = project(0, 1, 25).y;
    const by1 = project(0, 0, 25).y;
    boards.rect(-600, by0, VIEW_W + 1200, by1 - by0).fill(0x0a0f22);
    const segColors = [0x3a86ff, 0xff006e, 0x06d6a0, 0xffbe0b];
    for (let i = 0; i < 14; i++) {
      const x = -280 + i * 100;
      boards.roundRect(x + 4, by0 + 6, 90, by1 - by0 - 12, 4).fill({ color: segColors[i % 4], alpha: 0.55 });
    }
    this.world.addChild(boards);

    // Pitch with mowing stripes.
    const pitch = new Graphics();
    const zs = [30, 26, 22, 19, 17, 15, 13, 11, 9.5, 8, 6.8, 5.8, 5, 4.3, 3.7, 3.2, 2.8, 2.4, 2, 1.6];
    pitch.rect(-600, by1, VIEW_W + 1200, 2000).fill(0x1b6b34);
    for (let i = 0; i < zs.length - 1; i++) {
      const y0 = Math.max(by1, project(0, 0, zs[i]).y);
      const y1 = project(0, 0, zs[i + 1]).y;
      pitch.rect(-600, y0, VIEW_W + 1200, y1 - y0).fill(i % 2 ? 0x1f7a3b : 0x1a6a33);
    }
    // Lines: goal line, six-yard line, penalty spot.
    const line = (z: number) => {
      const p = project(0, 0, z);
      pitch.rect(-600, p.y - p.s * 0.06, VIEW_W + 1200, p.s * 0.12).fill({ color: 0xffffff, alpha: 0.85 });
    };
    line(GOAL_Z);
    line(GOAL_Z - 5.5);
    const spot = project(0, 0, SPOT_Z);
    pitch.ellipse(spot.x, spot.y, spot.s * 0.12, spot.s * 0.04).fill({ color: 0xffffff, alpha: 0.9 });
    // Vignette at the bottom so the HUD reads well.
    pitch.rect(-600, 1180, VIEW_W + 1200, 600).fill({ color: 0x000000, alpha: 0.25 });
    this.world.addChild(pitch);
  }

  private drawFrame(): void {
    const g = this.frameG.clear();
    const tl = project(-GOAL_HALF_W, GOAL_H, GOAL_Z);
    const tr = project(GOAL_HALF_W, GOAL_H, GOAL_Z);
    const bl = project(-GOAL_HALF_W, 0, GOAL_Z);
    const br = project(GOAL_HALF_W, 0, GOAL_Z);
    const w = GOAL_SCALE * 0.12;
    g.moveTo(bl.x, bl.y)
      .lineTo(tl.x, tl.y)
      .lineTo(tr.x, tr.y)
      .lineTo(br.x, br.y)
      .stroke({ width: w, color: 0xffffff, join: 'round', cap: 'round' });
    g.moveTo(bl.x + w * 0.25, bl.y)
      .lineTo(tl.x + w * 0.25, tl.y + w * 0.25)
      .lineTo(tr.x - w * 0.25, tr.y + w * 0.25)
      .lineTo(br.x - w * 0.25, br.y)
      .stroke({ width: w * 0.3, color: 0xc9d6e8, alpha: 0.7 });
  }

  /** Net with an optional ripple where the ball hit. */
  private drawNet(): void {
    const g = this.netG.clear();
    const r = this.ripple;
    const bulge = (x: number, y: number): number => {
      if (!r) return 0;
      const d2 = (x - r.x) * (x - r.x) + (y - r.y) * (y - r.y);
      const amp = Math.max(0, 1 - r.t / 0.9) * 0.9;
      return amp * Math.exp(-d2 / 0.6) * Math.cos(r.t * 14);
    };
    const back = (x: number, y: number) => project(x, y, NET_Z + bulge(x, y));
    const style = { width: 1.2, color: 0xffffff, alpha: 0.28 };

    // Back plane.
    for (let x = -GOAL_HALF_W; x <= GOAL_HALF_W + 0.01; x += 0.3) {
      for (let k = 0; k <= 8; k++) {
        const p = back(x, (NET_TOP * k) / 8);
        if (k === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
    }
    for (let y = 0; y <= NET_TOP + 0.01; y += 0.3) {
      for (let k = 0; k <= 16; k++) {
        const p = back(-GOAL_HALF_W + (2 * GOAL_HALF_W * k) / 16, y);
        if (k === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
    }
    g.stroke(style);

    // Roof and sides.
    for (let x = -GOAL_HALF_W; x <= GOAL_HALF_W + 0.01; x += 0.3) {
      const a = project(x, GOAL_H, GOAL_Z);
      const b = back(x, NET_TOP);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (const sx of [-GOAL_HALF_W, GOAL_HALF_W]) {
      for (let z = GOAL_Z; z <= NET_Z + 0.01; z += 0.4) {
        const top = GOAL_H + ((NET_TOP - GOAL_H) * (z - GOAL_Z)) / (NET_Z - GOAL_Z);
        const a = project(sx, 0, z);
        const b = project(sx, top, z);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      for (let y = 0; y <= GOAL_H; y += 0.3) {
        const a = project(sx, y, GOAL_Z);
        const b = project(sx, Math.min(y, NET_TOP), NET_Z);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
    }
    g.stroke({ ...style, alpha: 0.2 });
  }

  private drawBall(): void {
    const g = this.ballG.clear();
    const R = 50;
    g.circle(0, 0, R).fill(0xffffff);
    g.circle(0, 0, R).stroke({ width: 3, color: 0xcfd8e3 });
    g.poly(pentagon(0, 0, R * 0.32)).fill(0x1b1b1b);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      g.poly(pentagon(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82, R * 0.24, a)).fill(0x1b1b1b);
    }
    // Soft shading.
    g.circle(-R * 0.25, -R * 0.3, R * 0.55).fill({ color: 0xffffff, alpha: 0.25 });
    g.circle(R * 0.15, R * 0.2, R * 0.95).stroke({ width: R * 0.25, color: 0x000000, alpha: 0.08 });
    this.ball.addChild(this.ballG);
  }

  // --- placement ----------------------------------------------------------------------

  private placeKeeper(): void {
    const p = project(this.keeperPos.x, this.keeperPos.y, GOAL_Z);
    this.keeper.root.position.set(p.x, p.y);
    this.keeper.root.rotation = this.keeperRot;
    const sh = project(this.keeperPos.x, 0, GOAL_Z);
    const air = Math.max(0, this.keeperPos.y - 1.0);
    this.keeper.shadowGraphic.position.set(sh.x, sh.y);
    this.keeper.shadowGraphic.alpha = Math.max(0.2, 1 - air * 0.4);
  }

  private placeBall(): void {
    const { x, y, z } = this.ballPos;
    const p = project(x, y, z);
    this.ball.position.set(p.x, p.y);
    this.ball.scale.set((p.s * BALL_R) / 50);
    this.ball.rotation = this.ballSpin;
    const sh = project(x, 0, z);
    this.ballShadow
      .clear()
      .ellipse(sh.x, sh.y, p.s * BALL_R * 1.1, p.s * BALL_R * 0.35)
      .fill({ color: 0x000000, alpha: Math.max(0.1, 0.4 - y * 0.12) });
    // Once past the goal line the ball is drawn behind the keeper and the frame.
    const parent = z > GOAL_Z + 0.05 ? this.ballBack : this.ballFront;
    if (this.ball.parent !== parent) parent.addChild(this.ball);
  }

  // --- API used by the controller ------------------------------------------------------

  setKeeperKit(color: number): void {
    this.keeper.setKit(color);
  }

  resetKick(): void {
    this.tweens = [];
    this.timeScale = 1;
    this.keeperPos = { x: 0, y: 1.0 };
    this.keeperRot = 0;
    this.keeper.setStretch(false);
    this.keeper.root.scale.set(1);
    this.ballPos = { x: 0, y: BALL_R, z: SPOT_Z };
    this.ball.visible = true;
    this.ripple = null;
    this.drawNet();
    this.idle = null;
    this.showReticle(null, 0);
    this.showHeat(null);
    if (this.shooter) {
      this.world.removeChild(this.shooter.root);
      this.shooter = null;
    }
    this.placeKeeper();
    this.placeBall();
  }

  /** Keeper bounces on his line and slowly shifts his weight according to his tell. */
  keeperIdle(tell: Tell | null): void {
    this.idle = { tell, t: 0 };
  }

  showHeat(weights: number[] | null): void {
    const g = this.heatG.clear();
    if (!weights) return;
    const max = Math.max(...weights);
    ZONES.forEach((z, i) => {
      const x0 = -GOAL_HALF_W + (z.col + 1) * ((2 * GOAL_HALF_W) / 3);
      const y0 = z.row ? GOAL_H / 2 : 0;
      const a = project(x0, y0 + GOAL_H / 2, GOAL_Z);
      const b = project(x0 + (2 * GOAL_HALF_W) / 3, y0, GOAL_Z);
      const k = weights[i] / max;
      g.rect(a.x, a.y, b.x - a.x, b.y - a.y).fill({ color: 0xff3b3b, alpha: 0.05 + 0.3 * k * k });
    });
  }

  showReticle(p: Point | null, amp: number): void {
    const g = this.reticleG.clear();
    if (!p) return;
    const c = project(p.x, p.y, GOAL_Z);
    const risk = Math.min(1, amp / 0.6);
    const color = risk < 0.35 ? 0x7dffb0 : risk < 0.7 ? 0xffd166 : 0xff5d73;
    g.circle(c.x, c.y, Math.max(10, amp * GOAL_SCALE)).stroke({ width: 2, color, alpha: 0.35 });
    g.circle(c.x, c.y, 13).stroke({ width: 3, color });
    g.moveTo(c.x - 22, c.y)
      .lineTo(c.x - 7, c.y)
      .moveTo(c.x + 7, c.y)
      .lineTo(c.x + 22, c.y);
    g.moveTo(c.x, c.y - 22)
      .lineTo(c.x, c.y - 7)
      .moveTo(c.x, c.y + 7)
      .lineTo(c.x, c.y + 22);
    g.stroke({ width: 3, color });
  }

  /** Tweens something over `dur` seconds. Game-time by default (affected by slow motion). */
  tween(dur: number, fn: (k: number) => void, ease: Ease = linear, real = false): Promise<void> {
    return new Promise((done) => {
      fn(0);
      this.tweens.push({ t: 0, dur: Math.max(0.0001, dur), real, fn, ease, done });
    });
  }

  wait(dur: number, real = true): Promise<void> {
    return this.tween(dur, () => {}, linear, real);
  }

  /** Opponent's penalty taker runs up; his upper body leans according to `tell`. */
  async runUp(color: number, number: number, tell: Tell, dur: number): Promise<void> {
    if (this.shooter) this.world.removeChild(this.shooter.root);
    const sh = new ShooterFigure(SHOOTER_S, color, number);
    this.shooter = sh;
    this.world.addChildAt(sh.root, this.world.getChildIndex(this.ballShadow));
    const from = { x: -2.3, z: 2.6 };
    const to = { x: -0.85, z: SPOT_Z - 0.3 };
    await this.tween(
      dur,
      (k) => {
        const x = from.x + (to.x - from.x) * k;
        const z = from.z + (to.z - from.z) * k;
        const p = project(x, 0, z);
        sh.root.position.set(p.x, p.y + Math.abs(Math.sin(k * Math.PI * 5)) * -8);
        sh.root.scale.set((FOCAL / z / SHOOTER_S) * SHOOTER_SIZE);
        sh.lean(tell.col * 0.22 * tell.strength * Math.min(1, k * 1.6));
        sh.root.alpha = Math.min(1, k * 4);
      },
      easeInOut,
    );
  }

  fadeShooter(): void {
    const sh = this.shooter;
    if (!sh) return;
    void this.tween(0.25, (k) => (sh.root.alpha = 1 - k), linear, true);
  }

  /** Keeper commits his dive towards `end` (where his hands/body arrive). */
  dive(end: Point, dur: number): Promise<void> {
    this.idle = null;
    const start = { ...this.keeperPos };
    const startRot = this.keeperRot;
    const dx = end.x;
    const dy = end.y - 1.0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const reachBack = Math.min(0.55, len * 0.6);
    const body = { x: end.x - (dx / len) * reachBack, y: Math.max(0.35, end.y - (dy / len) * reachBack) };
    const rot = Math.max(-1.35, Math.min(1.35, Math.atan2(dx, Math.max(0.25, dy + 0.9))));
    const lowMiddle = Math.abs(dx) < 0.6 && end.y < 0.8;
    if (!lowMiddle) this.keeper.setStretch(Math.abs(rot) > 0.15 || dy > 0.3);
    return this.tween(
      dur,
      (k) => {
        this.keeperPos = { x: start.x + (body.x - start.x) * k, y: start.y + (body.y - start.y) * k + Math.sin(k * Math.PI) * 0.15 };
        this.keeperRot = startRot + (rot - startRot) * k;
        if (lowMiddle) this.keeper.root.scale.set(1, 1 - 0.18 * Math.sin(k * Math.PI * 0.5));
        this.placeKeeper();
      },
      easeOut,
    );
  }

  /** Ball flight from the spot to the goal line (game time). */
  flightTo(shot: Shot, dur: number): Promise<void> {
    const start = { x: 0, y: BALL_R, z: SPOT_Z };
    const lift = shot.y < 0.45 ? 0.05 : 0.35;
    return this.tween(dur, (k) => {
      this.ballPos = {
        x: start.x + (shot.x - start.x) * k,
        y: start.y + (shot.y - start.y) * k + lift * 4 * k * (1 - k),
        z: start.z + (GOAL_Z - start.z) * k,
      };
      this.ballSpin += 0.25;
      this.placeBall();
    });
  }

  /** What the ball does after reaching the line. */
  followThrough(shot: Shot, outcome: Outcome): void {
    const sx = Math.sign(shot.x) || 1;
    const from = { ...this.ballPos };
    const follow = (to: { x: number; y: number; z: number }, d: number, ease: Ease = easeOut) =>
      this.tween(
        d,
        (k) => {
          this.ballPos = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
          this.ballSpin += 0.15 * (1 - k);
          this.placeBall();
        },
        ease,
      );
    switch (outcome) {
      case 'goal':
        this.ripple = { x: shot.x, y: Math.min(NET_TOP - 0.1, shot.y), t: 0 };
        void follow({ x: shot.x * 1.03, y: Math.max(BALL_R, shot.y * 0.6), z: NET_Z - 0.15 }, 0.35);
        break;
      case 'saved':
        void follow({ x: shot.x + sx * 1.6, y: BALL_R, z: GOAL_Z - 3.5 }, 0.6);
        break;
      case 'post':
        void follow({ x: shot.x - sx * 1.4, y: 0.6, z: GOAL_Z - 4 }, 0.6);
        break;
      default:
        void follow({ x: shot.x * 1.5, y: shot.y * 1.25 + 0.3, z: GOAL_Z + 9 }, 0.6, linear);
    }
  }

  // --- juice ----------------------------------------------------------------------------

  shake(amount: number): void {
    this.shakeAmt = Math.min(30, this.shakeAmt + amount);
  }

  confetti(color: number): void {
    const colors = [color, 0xffffff, 0xffd166];
    for (let i = 0; i < 160; i++) {
      const max = 1.4 + Math.random() * 1.4;
      this.particles.push({
        x: Math.random() * VIEW_W,
        y: -40 - Math.random() * 300,
        vx: (Math.random() - 0.5) * 160,
        vy: 200 + Math.random() * 300,
        life: max,
        max,
        color: colors[i % 3],
        size: 3 + Math.random() * 4,
        gravity: 60,
      });
    }
  }

  burst(p: Point, color: number): void {
    const c = project(p.x, p.y, GOAL_Z);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 120 + Math.random() * 380;
      const max = 0.4 + Math.random() * 0.5;
      this.particles.push({
        x: c.x,
        y: c.y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: max,
        max,
        color,
        size: 2 + Math.random() * 3,
        gravity: 500,
      });
    }
  }

  cheer(): void {
    void this.tween(1.6, (k) => (this.stands.y = -Math.abs(Math.sin(k * Math.PI * 8)) * 6 * (1 - k)), linear, true);
  }

  /** Keeper's position on the goal plane (for tests/hooks). */
  get keeperPoint(): Point {
    return { ...this.keeperPos };
  }

  update(dt: number): void {
    this.time += dt;
    const gdt = dt * this.timeScale;
    this.gameClock += gdt;

    const active = this.tweens;
    this.tweens = [];
    const keep: Tween[] = [];
    for (const tw of active) {
      tw.t += tw.real ? dt : gdt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(tw.ease(k));
      if (k >= 1) tw.done();
      else keep.push(tw);
    }
    this.tweens = keep.concat(this.tweens);

    if (this.idle) {
      const it = this.idle;
      it.t += dt;
      const lean = it.tell ? it.tell.col * 0.32 * it.tell.strength * Math.min(1, it.t / 1.5) : 0;
      const bounce = Math.sin(this.time * 5.5) * 0.04;
      const step = Math.sin(this.time * 1.7) * 0.12;
      this.keeperPos = { x: step + lean, y: 1.0 + Math.abs(bounce) };
      this.keeperRot = lean * 0.25;
      this.placeKeeper();
    }

    if (this.ripple) {
      this.ripple.t += gdt;
      if (this.ripple.t > 0.9) this.ripple = null;
      this.drawNet();
    }

    const fx = this.fxG.clear();
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      fx.rect(p.x, p.y, p.size, p.size * 0.6).fill({ color: p.color, alpha: Math.min(1, k * 1.5) });
    }

    this.shakeAmt *= Math.pow(0.004, dt);
    this.world.position.set((Math.random() - 0.5) * this.shakeAmt, (Math.random() - 0.5) * this.shakeAmt);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

function pentagon(cx: number, cy: number, r: number, rot = -Math.PI / 2): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = rot + (i / 5) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/** Where on screen the camera's horizon sits (for HUD layout). */
export const HORIZON_Y = HORIZON;
export const CAMERA_HEIGHT = CAM_H;
