// Top-down 6v6 pitch. Each player sees their own team attacking up the screen.

import { Container, Graphics, Text } from 'pixi.js';
import { BOX_DEPTH, BOX_HALF_W, GOAL_HALF, HALF_L, HALF_W, SIX_DEPTH, SIX_HALF_W, type Team } from '../match/types';
import type { ViewState } from '../match/view';
import type { Scene } from './app';
import { VIEW_H, VIEW_W } from './app';

export const PX = 16; // pixels per metre
const CX = VIEW_W / 2;
const CY = VIEW_H / 2 + 34;
const PLAYER_DRAW_R = 0.85;

export interface TeamKit {
  color: number;
  keeper: number;
}

export class MatchScene implements Scene {
  readonly root = new Container();
  private readonly world = new Container();
  private readonly pitch = new Graphics();
  private readonly marks = new Graphics();
  private readonly players = new Graphics();
  private readonly ballG = new Graphics();
  private readonly fx = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private flip = 1;
  private shakeAmt = 0;
  private time = 0;
  private particles: { x: number; y: number; vx: number; vy: number; life: number; max: number; color: number }[] = [];
  view: ViewState | null = null;
  names = new Map<number, string>();
  mySlot = -1;

  constructor(
    readonly viewTeam: Team,
    readonly kits: [TeamKit, TeamKit],
  ) {
    this.flip = viewTeam === 0 ? 1 : -1;
    this.drawPitch();
    this.fx.blendMode = 'add';
    this.world.addChild(this.pitch, this.marks, this.players, this.ballG, this.labels, this.fx);
    this.root.addChild(this.world);
  }

  /** Pitch metres -> screen pixels (in the 720x1280 logical view). */
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: CX + x * PX * this.flip, y: CY - y * PX * this.flip };
  }

  private drawPitch(): void {
    const g = this.pitch;
    // Stadium surround.
    g.rect(-400, -400, VIEW_W + 800, VIEW_H + 800).fill(0x0b1a12);
    const tl = this.toScreen(-HALF_W * this.flip, HALF_L * this.flip);
    const w = HALF_W * 2 * PX;
    const h = HALF_L * 2 * PX;
    // Run-off area and boards.
    g.roundRect(tl.x - 26, tl.y - 46, w + 52, h + 92, 18).fill(0x15442a);
    g.roundRect(tl.x - 30, tl.y - 50, w + 60, h + 100, 20).stroke({ width: 6, color: 0x0f2a1b });
    // Grass stripes.
    for (let i = 0; i < 12; i++) {
      g.rect(tl.x, tl.y + (h / 12) * i, w, h / 12).fill(i % 2 ? 0x2a8a47 : 0x26803f);
    }
    const line = { width: 2.5, color: 0xffffff, alpha: 0.85 };
    g.rect(tl.x, tl.y, w, h).stroke(line);
    g.moveTo(tl.x, CY)
      .lineTo(tl.x + w, CY)
      .stroke(line);
    g.circle(CX, CY, 5 * PX).stroke(line);
    g.circle(CX, CY, 3).fill(0xffffff);
    for (const s of [1, -1]) {
      const gy = CY - s * HALF_L * PX;
      // Boxes.
      g.rect(CX - BOX_HALF_W * PX, s > 0 ? gy : gy - BOX_DEPTH * PX, BOX_HALF_W * 2 * PX, BOX_DEPTH * PX).stroke(line);
      g.rect(CX - SIX_HALF_W * PX, s > 0 ? gy : gy - SIX_DEPTH * PX, SIX_HALF_W * 2 * PX, SIX_DEPTH * PX).stroke(line);
      g.circle(CX, gy + s * 6 * PX, 2.5).fill(0xffffff);
      // Goals with nets.
      const depth = 1.4 * PX;
      const gx = CX - GOAL_HALF * PX;
      const gy0 = s > 0 ? gy - depth : gy;
      g.rect(gx, gy0, GOAL_HALF * 2 * PX, depth).fill({ color: 0xffffff, alpha: 0.12 });
      for (let x = gx; x <= gx + GOAL_HALF * 2 * PX; x += 8) g.moveTo(x, gy0).lineTo(x, gy0 + depth);
      for (let y = gy0; y <= gy0 + depth; y += 8) g.moveTo(gx, y).lineTo(gx + GOAL_HALF * 2 * PX, y);
      g.stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
      g.rect(gx, gy0, GOAL_HALF * 2 * PX, depth).stroke({ width: 3, color: 0xffffff });
    }
  }

  private label(i: number, text: string, x: number, y: number, color: number): void {
    let t = this.labelPool[i];
    if (!t) {
      t = new Text({
        text: '',
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: 15,
          fontWeight: '800',
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 4 },
        },
      });
      t.anchor.set(0.5, 1);
      this.labelPool[i] = t;
      this.labels.addChild(t);
    }
    t.visible = true;
    t.text = text;
    t.style.fill = color;
    t.position.set(x, y);
  }

  shake(n: number): void {
    this.shakeAmt = Math.min(20, this.shakeAmt + n);
  }

  burst(x: number, y: number, color: number, n = 40): void {
    const s = this.toScreen(x, y);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 320;
      const max = 0.5 + Math.random() * 0.6;
      this.particles.push({ x: s.x, y: s.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color });
    }
  }

  update(dt: number): void {
    this.time += dt;
    const v = this.view;
    const pg = this.players.clear();
    const mg = this.marks.clear();
    for (const l of this.labelPool) l.visible = false;
    if (v) {
      let li = 0;
      // Shot target glow during a duel.
      if (v.duel) {
        const t = this.toScreen(v.duel.tx, v.duel.ty);
        mg.circle(t.x, t.y, 18 + Math.sin(this.time * 20) * 4).fill({ color: 0xff4d6d, alpha: 0.35 });
      }
      for (const p of v.players) {
        const s = this.toScreen(p.x, p.y);
        const kit = this.kits[p.team];
        const r = PLAYER_DRAW_R * PX;
        // Shadow.
        pg.ellipse(s.x + 3, s.y + 4, r, r * 0.8).fill({ color: 0x000000, alpha: 0.28 });
        if (p.human >= 0) {
          const mine = p.human === this.mySlot;
          const c = mine ? 0xffe14d : 0xffffff;
          pg.circle(s.x, s.y, r + 6 + Math.sin(this.time * 8) * 1.5).stroke({ width: 3, color: c, alpha: 0.95 });
          if (p.sprinting) pg.circle(s.x, s.y, r + 11).stroke({ width: 2, color: 0xff6b6b, alpha: 0.7 });
          const name = this.names.get(p.human) ?? (mine ? 'YOU' : `P${p.human + 1}`);
          this.label(li++, mine ? 'YOU' : name, s.x, s.y - r - 9, c);
        }
        pg.circle(s.x, s.y, r)
          .fill(p.role === 0 ? kit.keeper : kit.color)
          .stroke({ width: 2.5, color: 0x0a0a0a, alpha: 0.6 });
        // Facing nub.
        const fx = p.fx * this.flip;
        const fy = -p.fy * this.flip;
        pg.circle(s.x + fx * r * 0.62, s.y + fy * r * 0.62, r * 0.32).fill({ color: 0xffffff, alpha: 0.9 });
      }
      // Ball (lifts and grows with height).
      const b = this.toScreen(v.ball.x, v.ball.y);
      const z = v.ball.z;
      const bg = this.ballG.clear();
      bg.ellipse(b.x + 2 + z * 4, b.y + 3 + z * 6, 6, 4).fill({ color: 0x000000, alpha: 0.35 });
      const br = 6 + z * 2.5;
      bg.circle(b.x, b.y - z * 10, br)
        .fill(0xffffff)
        .stroke({ width: 1.5, color: 0x222222 });
      bg.circle(b.x - br * 0.2, b.y - z * 10 - br * 0.1, br * 0.35).fill(0x222222);
    }

    const fx = this.fx.clear();
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.vx *= 1 - dt * 2;
      p.vy *= 1 - dt * 2;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      fx.circle(p.x, p.y, 3 * (p.life / p.max) + 1).fill({ color: p.color, alpha: p.life / p.max });
    }
    this.shakeAmt *= Math.pow(0.003, dt);
    this.world.position.set((Math.random() - 0.5) * this.shakeAmt, (Math.random() - 0.5) * this.shakeAmt);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
