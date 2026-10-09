// Landscape 6v6 match view: stadium, pitch, animated top-down players, ball, effects.
// Each player sees their own team attacking to the RIGHT of the screen.
//
// Pitch metres -> world pixels: world.x = pitch.y * PX * flip, world.y = pitch.x * PX * flip.
// A camera container then follows the action.

import { BlurFilter, Container, Graphics, Text } from 'pixi.js';
import { BOX_DEPTH, BOX_HALF_W, FIREBALL, GOAL_HALF, HALF_L, HALF_W, SIX_DEPTH, SIX_HALF_W, type Team } from '../match/types';
import type { ViewState } from '../match/view';
import type { Scene } from './app';
import { VIEW_H, VIEW_W } from './app';

export const PX = 22; // world pixels per metre
/** Disc radius in metres (drawn a bit larger than a real player so it reads on a phone). */
const DISC_R = 0.78;
const GOAL_DEPTH = 1.8;
/** Camera zoom: close enough to see the players clearly; the camera follows the ball. */
const BASE_ZOOM = 1.45;

export interface TeamKit {
  color: number;
  /** Second kit colour (stripes / trim). */
  trim: number;
  shorts: number;
  keeper: number;
}

function shade(c: number, k: number): number {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255);
}

function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** One player: a modern disc token with a shirt number and a facing arrow on its rim. */
class PlayerSprite {
  readonly root = new Container();
  readonly body = new Container();
  /** Rotates to show which way the player faces. */
  readonly pointer = new Graphics();
  readonly ring = new Graphics();
  private lastX = 0;
  private lastY = 0;
  private pulse = 0;

  constructor(kit: TeamKit, keeper: boolean, number: number) {
    const R = DISC_R * PX;
    const color = keeper ? kit.keeper : kit.color;
    const disc = new Graphics();
    // Depth: darker base, main colour slightly up-left, soft highlight, crisp rim.
    disc.circle(0, 0, R).fill(shade(color, 0.62));
    disc.circle(-R * 0.03, -R * 0.06, R * 0.93).fill(color);
    disc.ellipse(-R * 0.22, -R * 0.36, R * 0.62, R * 0.4).fill({ color: 0xffffff, alpha: 0.22 });
    disc.circle(0, 0, R).stroke({ width: R * 0.13, color: 0xffffff, alpha: 0.96 });
    disc.circle(0, 0, R * 0.9).stroke({ width: R * 0.05, color: keeper ? 0x111111 : kit.trim, alpha: keeper ? 0.25 : 0.35 });
    const dark = ((color >> 16) & 255) * 0.3 + ((color >> 8) & 255) * 0.59 + (color & 255) * 0.11 > 170;
    const label = new Text({
      text: String(number),
      style: {
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: Math.round(R * 1.05),
        fontWeight: '900',
        fill: dark ? 0x121521 : 0xffffff,
        stroke: { color: dark ? 0xffffff : 0x0b0f1a, width: 2, alpha: 0.35 },
      },
    });
    label.anchor.set(0.5, 0.52);
    label.resolution = 3;

    // Facing arrow: a small chevron just outside the rim.
    this.pointer.poly([R * 1.12, -R * 0.36, R * 1.62, 0, R * 1.12, R * 0.36]).fill({ color: 0xffffff, alpha: 0.95 });
    this.pointer
      .poly([R * 1.12, -R * 0.36, R * 1.62, 0, R * 1.12, R * 0.36])
      .stroke({ width: 1.5, color: 0x0b0f1a, alpha: 0.35, join: 'round' });

    this.body.addChild(disc, label);
    this.root.addChild(this.ring, this.pointer, this.body);
  }

  /** Small squash-and-stretch while moving. */
  animate(x: number, y: number, dt: number): void {
    const d = Math.hypot(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
    const speed = dt > 0 ? d / dt : 0;
    this.pulse += d * 0.25;
    const k = Math.min(1, speed / 120) * 0.04;
    this.body.scale.set(1 + Math.sin(this.pulse) * k, 1 - Math.sin(this.pulse) * k);
  }
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
  grow: number;
  drag: number;
}

export class MatchScene implements Scene {
  readonly root = new Container();
  private readonly cam = new Container();
  private readonly world = new Container();
  private readonly shadowLayer = new Graphics();
  private readonly netG = new Graphics();
  private readonly marks = new Graphics();
  private readonly playersLayer = new Container();
  private readonly trailG = new Graphics();
  private readonly ballShadow = new Graphics();
  private readonly ball = new Container();
  private readonly ballG = new Graphics();
  private readonly fxG = new Graphics();
  private readonly glowG = new Graphics();
  private readonly overlay = new Container();
  private readonly sprites: PlayerSprite[] = [];
  private readonly tags = new Map<number, Container>();
  private readonly flip: number;
  private particles: Particle[] = [];
  private trail: { x: number; y: number }[] = [];
  private shakeAmt = 0;
  private time = 0;
  private camX = 0;
  private camY = 0;
  private zoom = BASE_ZOOM;
  private ballSpin = 0;
  private ripple: { side: number; y: number; t: number } | null = null;
  view: ViewState | null = null;
  names = new Map<number, string>();
  mySlot = -1;

  constructor(
    readonly viewTeam: Team,
    readonly kits: [TeamKit, TeamKit],
  ) {
    this.flip = viewTeam === 0 ? 1 : -1;
    const vignette = this.buildStadium();
    this.shadowLayer.filters = [new BlurFilter({ strength: 3, quality: 2 })];
    this.shadowLayer.alpha = 0.45;
    this.fxG.blendMode = 'add';
    this.glowG.blendMode = 'add';
    this.glowG.filters = [new BlurFilter({ strength: 6, quality: 2 })];
    this.drawBall();
    this.world.addChild(
      this.netG,
      this.marks,
      this.shadowLayer,
      this.trailG,
      this.playersLayer,
      this.ballShadow,
      this.ball,
      this.glowG,
      this.fxG,
      this.overlay,
    );
    this.cam.addChild(this.world);
    this.root.addChild(this.cam, vignette);
  }

  /** Pitch metres -> world pixels. */
  w(x: number, y: number): { x: number; y: number } {
    return { x: y * PX * this.flip, y: x * PX * this.flip };
  }

  // --- static stadium ----------------------------------------------------------------------

  private buildStadium(): Graphics {
    const L = HALF_L * PX;
    const W = HALF_W * PX;
    const g = new Graphics();
    // Stands around the pitch.
    g.rect(-L - 600, -W - 600, 2 * L + 1200, 2 * W + 1200).fill(0x070b16);
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const crowd = [0xffffff, 0xe63946, 0x3a86ff, 0xffd166, 0x06d6a0, 0xb8c0ff];
    for (let i = 0; i < 2600; i++) {
      // A ring of seats outside the boards.
      const side = Math.floor(rand() * 4);
      const along = rand();
      const depth = 6 + rand() * 9;
      let x = 0;
      let y = 0;
      if (side < 2) {
        x = -L - 120 + along * (2 * L + 240);
        y = (side === 0 ? -1 : 1) * (W + depth * PX * 0.6);
      } else {
        y = -W - 120 + along * (2 * W + 240);
        x = (side === 2 ? -1 : 1) * (L + depth * PX * 0.6);
      }
      g.circle(x, y, 2 + rand() * 2.2).fill({ color: crowd[Math.floor(rand() * crowd.length)], alpha: 0.25 + rand() * 0.35 });
    }
    // LED boards.
    const board = (x: number, y: number, w: number, h: number, i: number) => {
      const c = [0x3a86ff, 0xff006e, 0x06d6a0, 0xffbe0b][i % 4];
      g.roundRect(x, y, w, h, 4).fill(0x0b1022);
      g.roundRect(x + 3, y + 3, w - 6, h - 6, 3).fill({ color: c, alpha: 0.55 });
    };
    const bw = 8 * PX;
    for (let i = 0; i < 16; i++) {
      board(-L + i * bw - 10, -W - 3.2 * PX, bw - 6, 0.9 * PX, i);
      board(-L + i * bw - 10, W + 2.3 * PX, bw - 6, 0.9 * PX, i + 2);
    }
    for (let i = 0; i < 5; i++) {
      board(-L - 3.4 * PX, -W + i * bw + 10, 0.9 * PX, bw - 6, i + 1);
      board(L + 2.5 * PX, -W + i * bw + 10, 0.9 * PX, bw - 6, i + 3);
    }

    // Run-off grass and the pitch with mowing stripes (both directions, subtle).
    g.roundRect(-L - 2.2 * PX, -W - 2.2 * PX, 2 * L + 4.4 * PX, 2 * W + 4.4 * PX, 10).fill(0x1d6a37);
    const bands = 14;
    for (let i = 0; i < bands; i++) {
      g.rect(-L + (2 * L * i) / bands, -W, (2 * L) / bands, 2 * W).fill(i % 2 ? 0x2b8f4a : 0x268443);
    }
    for (let j = 0; j < 8; j++) {
      if (j % 2) g.rect(-L, -W + (2 * W * j) / 8, 2 * L, (2 * W) / 8).fill({ color: 0x000000, alpha: 0.035 });
    }

    // Markings.
    const line = { width: 0.13 * PX, color: 0xffffff, alpha: 0.88 };
    g.rect(-L, -W, 2 * L, 2 * W).stroke(line);
    g.moveTo(0, -W).lineTo(0, W).stroke(line);
    g.circle(0, 0, 5 * PX).stroke(line);
    g.circle(0, 0, 0.25 * PX).fill(0xffffff);
    for (const s of [-1, 1]) {
      const gx = s * L;
      g.rect(s > 0 ? gx - BOX_DEPTH * PX : gx, -BOX_HALF_W * PX, BOX_DEPTH * PX, BOX_HALF_W * 2 * PX).stroke(line);
      g.rect(s > 0 ? gx - SIX_DEPTH * PX : gx, -SIX_HALF_W * PX, SIX_DEPTH * PX, SIX_HALF_W * 2 * PX).stroke(line);
      g.circle(gx - s * 6 * PX, 0, 0.22 * PX).fill(0xffffff);
      // Penalty arc outside the box.
      const cx = gx - s * 6 * PX;
      const r = 4.2 * PX;
      const a = Math.acos((BOX_DEPTH - 6) / 4.2);
      const a0 = s > 0 ? Math.PI - a : -a;
      g.moveTo(cx + Math.cos(a0) * r, Math.sin(a0) * r);
      g.arc(cx, 0, r, a0, a0 + 2 * a);
      g.stroke(line);
      // Corner arcs.
      for (const t of [-1, 1]) {
        const cy = t * W;
        const start = s > 0 ? (t > 0 ? Math.PI : Math.PI / 2) : t > 0 ? -Math.PI / 2 : 0;
        g.moveTo(gx + Math.cos(start) * PX, cy + Math.sin(start) * PX);
        g.arc(gx, cy, PX, start, start + Math.PI / 2);
        g.stroke(line);
      }
    }

    // Floodlight pools and vignette.
    const light = new Graphics();
    for (const [x, y] of [
      [-L * 0.6, -W * 0.7],
      [L * 0.6, -W * 0.7],
      [-L * 0.6, W * 0.7],
      [L * 0.6, W * 0.7],
    ]) {
      light.ellipse(x, y, L * 0.55, W * 0.65).fill({ color: 0xfff6d8, alpha: 0.07 });
    }
    light.filters = [new BlurFilter({ strength: 60, quality: 3 })];
    light.blendMode = 'add';
    const vignette = new Graphics();
    vignette.rect(-L - 600, -W - 600, 2 * L + 1200, 2 * W + 1200).stroke({ width: 900, color: 0x000000, alpha: 0.35 });
    vignette.filters = [new BlurFilter({ strength: 80, quality: 2 })];

    this.world.addChild(g, light);
    return vignette;
  }

  /** Goal frames and nets (redrawn when the net ripples). */
  private drawGoals(): void {
    const n = this.netG.clear();
    const L = HALF_L * PX;
    const half = GOAL_HALF * PX;
    const depth = GOAL_DEPTH * PX;
    for (const s of [-1, 1]) {
      const line = s * L;
      const back = line + s * depth;
      // Net (top-down): mesh with optional ripple bulge.
      const r = this.ripple && this.ripple.side === s ? this.ripple : null;
      const bulge = (yy: number) => {
        if (!r) return 0;
        const amp = Math.max(0, 1 - r.t / 0.9) * 0.6 * PX;
        return amp * Math.exp(-((yy - r.y) * (yy - r.y)) / (2.2 * PX * PX)) * Math.cos(r.t * 16);
      };
      n.rect(Math.min(line, back), -half, depth, 2 * half).fill({ color: 0xffffff, alpha: 0.08 });
      for (let yy = -half; yy <= half + 0.1; yy += 0.4 * PX) {
        n.moveTo(line, yy).lineTo(back + s * bulge(yy), yy);
      }
      for (let k = 0; k <= 4; k++) {
        const xx = line + (s * depth * k) / 4;
        n.moveTo(xx, -half);
        for (let yy = -half; yy <= half + 0.1; yy += 0.4 * PX) n.lineTo(xx + (s * bulge(yy) * k) / 4, yy);
      }
      n.stroke({ width: 1, color: 0xffffff, alpha: 0.4 });
      // Frame: posts and crossbar seen from above.
      n.moveTo(back, -half).lineTo(line, -half).lineTo(line, half).lineTo(back, half).stroke({ width: 2, color: 0xdfe6f0, alpha: 0.7 });
      n.moveTo(line, -half)
        .lineTo(line, half)
        .stroke({ width: 0.24 * PX, color: 0xffffff });
      n.circle(line, -half, 0.16 * PX).fill(0xffffff);
      n.circle(line, half, 0.16 * PX).fill(0xffffff);
    }
  }

  private drawBall(): void {
    const g = this.ballG;
    const R = 50;
    g.circle(0, 0, R).fill(0xfafafa);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const d = i === 0 ? 0 : R * 0.68;
      const cx = i === 0 ? 0 : Math.cos(a) * d;
      const cy = i === 0 ? 0 : Math.sin(a) * d;
      const pts: number[] = [];
      for (let k = 0; k < 5; k++) {
        const b = a + (k / 5) * Math.PI * 2;
        pts.push(cx + Math.cos(b) * R * 0.26, cy + Math.sin(b) * R * 0.26);
      }
      g.poly(pts).fill(0x1c1c22);
    }
    g.circle(0, 0, R).stroke({ width: 4, color: 0x9aa3b2, alpha: 0.6 });
    this.ball.addChild(g);
    const shine = new Graphics().circle(-R * 0.3, -R * 0.32, R * 0.42).fill({ color: 0xffffff, alpha: 0.35 });
    this.ball.addChild(shine);
  }

  // --- effects ---------------------------------------------------------------------------------

  shake(n: number): void {
    this.shakeAmt = Math.min(22, this.shakeAmt + n);
  }

  private emit(p: Partial<Particle> & { x: number; y: number }): void {
    const life = p.life ?? 0.5;
    this.particles.push({ vx: 0, vy: 0, color: 0xffffff, size: 3, grow: 0, drag: 2, ...p, life, max: life });
  }

  burst(x: number, y: number, color: number, n = 40): void {
    const c = this.w(x, y);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 360;
      this.emit({
        x: c.x,
        y: c.y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 0.5 + Math.random() * 0.7,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  confetti(color: number): void {
    const colors = [color, 0xffffff, 0xffd166];
    const c = this.w(this.view?.ball.x ?? 0, this.view?.ball.y ?? 0);
    for (let i = 0; i < 120; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const v = 200 + Math.random() * 500;
      this.emit({
        x: c.x,
        y: c.y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 1.2 + Math.random(),
        color: colors[i % 3],
        size: 3 + Math.random() * 3,
        drag: 1.2,
      });
    }
  }

  netRipple(team: Team, x: number): void {
    // Which end (in world space) the ball went into.
    const goalY = team === 0 ? HALF_L : -HALF_L;
    this.ripple = { side: Math.sign(goalY * this.flip), y: x * PX * this.flip, t: 0 };
  }

  private nameTag(slot: number, text: string, mine: boolean): Container {
    let tag = this.tags.get(slot);
    if (!tag) {
      tag = new Container();
      const label = new Text({
        text,
        style: {
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          fontSize: 13,
          fontWeight: '800',
          fill: mine ? 0x10131c : 0xffffff,
          letterSpacing: 0.5,
        },
      });
      label.anchor.set(0.5);
      const bg = new Graphics();
      const w = label.width + 16;
      bg.roundRect(-w / 2, -11, w, 22, 11).fill({ color: mine ? 0xffe14d : 0x111522, alpha: mine ? 1 : 0.85 });
      if (!mine) bg.roundRect(-w / 2, -11, w, 22, 11).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
      const arrow = new Graphics().poly([-6, 11, 6, 11, 0, 18]).fill({ color: mine ? 0xffe14d : 0x111522, alpha: mine ? 1 : 0.85 });
      tag.addChild(bg, arrow, label);
      this.overlay.addChild(tag);
      this.tags.set(slot, tag);
    }
    return tag;
  }

  // --- per frame -------------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    const v = this.view;
    if (v) this.drawView(v, dt);
    this.drawGoals();
    if (this.ripple) {
      this.ripple.t += dt;
      if (this.ripple.t > 0.9) this.ripple = null;
    }

    // Particles.
    const fx = this.fxG.clear();
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.grow * dt;
      const a = p.life / p.max;
      fx.circle(p.x, p.y, Math.max(0.5, p.size * (0.5 + a * 0.5))).fill({ color: p.color, alpha: Math.min(1, a * 1.4) });
    }

    // Camera: follow the ball, zoom in on shots, gentle shake.
    let target = v ? this.w(v.ball.x, v.ball.y) : { x: 0, y: 0 };
    // During a shot, frame both the ball and the goal.
    if (v?.duel && v.state === 'duel') {
      const g = this.w(v.duel.tx, v.duel.ty);
      target = { x: (target.x + g.x) / 2, y: (target.y + g.y) / 2 };
    }
    const zoomTarget = BASE_ZOOM * (v?.state === 'duel' ? 1.15 : v?.state === 'goal' ? 1.1 : 1);
    this.zoom += (zoomTarget - this.zoom) * Math.min(1, dt * 3);
    this.camX += (target.x - this.camX) * Math.min(1, dt * 3.2);
    this.camY += (target.y - this.camY) * Math.min(1, dt * 3.2);
    const halfVw = VIEW_W / 2 / this.zoom;
    const halfVh = VIEW_H / 2 / this.zoom;
    // Let the camera run past the end lines so a goal never hides under the on-screen buttons.
    const maxX = Math.max(0, (HALF_L + 14) * PX - halfVw);
    const maxY = Math.max(0, (HALF_W + 4) * PX - halfVh);
    const cx = Math.max(-maxX, Math.min(maxX, this.camX));
    const cy = Math.max(-maxY, Math.min(maxY, this.camY));
    this.shakeAmt *= Math.pow(0.003, dt);
    this.world.scale.set(this.zoom);
    // Focus a little left of centre: the buttons live on the right, where you attack.
    this.world.position.set(
      VIEW_W * 0.45 - cx * this.zoom + (Math.random() - 0.5) * this.shakeAmt,
      VIEW_H / 2 + 14 - cy * this.zoom + (Math.random() - 0.5) * this.shakeAmt,
    );
  }

  private drawView(v: ViewState, dt: number): void {
    // Lazily create one sprite per player.
    while (this.sprites.length < v.players.length) {
      const i = this.sprites.length;
      const p = v.players[i];
      const s = new PlayerSprite(this.kits[p.team], p.role === 0, [1, 4, 5, 8, 7, 9][p.role] ?? i);
      this.sprites.push(s);
      this.playersLayer.addChild(s.root);
    }

    const shadow = this.shadowLayer.clear();
    const marks = this.marks.clear();
    const glow = this.glowG.clear();
    const usedTags = new Set<number>();

    // Pass target / shot target hints.
    if (v.duel) {
      const t = this.w(v.duel.tx, v.duel.ty);
      marks.circle(t.x, t.y, 0.9 * PX + Math.sin(this.time * 18) * 3).fill({ color: 0xff4d6d, alpha: 0.28 });
    }

    // Draw back-to-front by screen y so overlaps look right.
    const order = v.players
      .map((_, i) => i)
      .sort((a, b) => this.w(v.players[a].x, v.players[a].y).y - this.w(v.players[b].x, v.players[b].y).y);
    order.forEach((i, z) => {
      const p = v.players[i];
      const s = this.sprites[i];
      const pos = this.w(p.x, p.y);
      s.root.position.set(pos.x, pos.y);
      s.root.zIndex = z;
      const fx = p.fy * this.flip;
      const fy = p.fx * this.flip;
      s.pointer.rotation = Math.atan2(fy, fx);
      s.animate(pos.x, pos.y, dt);
      shadow.circle(pos.x + 3, pos.y + 6, DISC_R * PX * 1.02).fill(0x000000);

      // Rings: you (yellow), friends (white), ball carrier (subtle).
      const ring = s.ring.clear();
      const r = DISC_R * PX * 1.05;
      if (p.human >= 0) {
        const mine = p.human === this.mySlot;
        const c = mine ? 0xffe14d : 0xffffff;
        ring.circle(0, 0, r + 3).stroke({ width: 3, color: c, alpha: 0.9 });
        const a0 = this.time * 3;
        ring.arc(0, 0, r + 8, a0, a0 + 1.2).stroke({ width: 3, color: c, alpha: 0.7, cap: 'round' });
        ring.arc(0, 0, r + 8, a0 + Math.PI, a0 + Math.PI + 1.2).stroke({ width: 3, color: c, alpha: 0.7, cap: 'round' });
        glow.circle(pos.x, pos.y, r + 6).fill({ color: c, alpha: 0.18 });
        // Shot charge meter.
        if (p.charge >= 0) {
          const full = p.charge >= 0.999;
          const col = full ? 0xff3b1f : mix(0xffe14d, 0xff7a00, p.charge);
          ring
            .arc(0, 0, r + 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, p.charge))
            .stroke({ width: 6, color: col, cap: 'round' });
          if (full || Math.random() < p.charge * 0.6) {
            const a = Math.random() * Math.PI * 2;
            this.emit({
              x: pos.x + Math.cos(a) * (r + 14),
              y: pos.y + Math.sin(a) * (r + 14),
              vy: -60,
              life: 0.35,
              color: full ? 0xff5a1f : 0xffc14d,
              size: full ? 4 : 2.5,
              grow: -4,
            });
          }
        }
        const tag = this.nameTag(p.human, mine ? 'YOU' : (this.names.get(p.human) ?? `P${p.human + 1}`), mine);
        tag.position.set(pos.x, pos.y - r - 26);
        tag.visible = true;
        usedTags.add(p.human);
      } else if (v.ball.owner === i) {
        ring.circle(0, 0, r + 3).stroke({ width: 2, color: 0xffffff, alpha: 0.45 });
      }
      // Sprint dust.
      if (p.sprinting && Math.random() < 0.5) {
        this.emit({
          x: pos.x - fx * r,
          y: pos.y - fy * r,
          vx: -fx * 40 + (Math.random() - 0.5) * 30,
          vy: -fy * 40 + (Math.random() - 0.5) * 30,
          life: 0.45,
          color: 0xc9e8b8,
          size: 2.5,
          grow: 6,
          drag: 3,
        });
      }
    });
    this.playersLayer.sortableChildren = true;
    for (const [slot, tag] of this.tags) if (!usedTags.has(slot)) tag.visible = false;

    // Ball: shadow, spin, height, trails.
    const b = this.w(v.ball.x, v.ball.y);
    const z = v.ball.z;
    const lift = z * PX * 0.75;
    const br = 0.24 * PX * 1.45 * (1 + z * 0.22);
    shadow.ellipse(b.x + 3 + z * 6, b.y + 5 + z * 9, br * 1.05, br * 0.8).fill(0x000000);
    this.ballShadow
      .clear()
      .ellipse(b.x + z * 6, b.y + 2 + z * 9, br * 0.9, br * 0.55)
      .fill({ color: 0x000000, alpha: 0.3 });
    const prev = this.trail[this.trail.length - 1];
    const moved = prev ? Math.hypot(b.x - prev.x, b.y - lift - prev.y) : 0;
    this.ballSpin += moved * 0.08;
    this.ball.position.set(b.x, b.y - lift);
    this.ball.scale.set(br / 50);
    this.ballG.rotation = this.ballSpin;
    this.trail.push({ x: b.x, y: b.y - lift });
    if (this.trail.length > 14) this.trail.shift();

    const tg = this.trailG.clear();
    const d = v.duel;
    const fire = !!d && v.state === 'duel' && d.power >= FIREBALL;
    const shot = !!d && v.state === 'duel';
    if (moved > 2.5 || shot) {
      for (let k = 1; k < this.trail.length; k++) {
        const a = this.trail[k - 1];
        const c = this.trail[k];
        const t = k / this.trail.length;
        tg.moveTo(a.x, a.y)
          .lineTo(c.x, c.y)
          .stroke({
            width: br * 2 * t * (fire ? 1.3 : 1),
            color: fire ? mix(0xff2a00, 0xffd34d, t) : 0xffffff,
            alpha: t * (shot ? 0.7 : 0.35),
            cap: 'round',
          });
      }
    }
    if (fire) {
      // Flaming tail.
      for (let k = 0; k < 10; k++) {
        const dirx = prev ? b.x - prev.x : 0;
        const diry = prev ? b.y - lift - prev.y : 0;
        const l = Math.hypot(dirx, diry) || 1;
        this.emit({
          x: b.x + (Math.random() - 0.5) * br,
          y: b.y - lift + (Math.random() - 0.5) * br,
          vx: (-dirx / l) * (120 + Math.random() * 160) + (Math.random() - 0.5) * 60,
          vy: (-diry / l) * (120 + Math.random() * 160) + (Math.random() - 0.5) * 60,
          life: 0.25 + Math.random() * 0.3,
          color: [0xff2a00, 0xff7a00, 0xffc14d, 0xfff1a8][k % 4],
          size: br * (0.8 + Math.random() * 0.9),
          grow: -br * 2.4,
          drag: 2,
        });
      }
      glow.circle(b.x, b.y - lift, br * 4).fill({ color: 0xff6a00, alpha: 0.7 });
      glow.circle(b.x, b.y - lift, br * 2).fill({ color: 0xffe08a, alpha: 0.8 });
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
