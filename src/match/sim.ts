// The authoritative 6v6 match simulation. Runs on the host (or locally vs the computer).
// Fixed 60 Hz tick. Clients never run this: they only send inputs and draw snapshots.

import { Rng } from '../core/rng';
import { type Zone, ZONES } from '../duel/goal';
import { aiThink } from './ai';
import {
  attackGoalY,
  type Ball,
  DT,
  type Duel,
  GOAL_HALF,
  HALF_L,
  HALF_W,
  type Input,
  type MatchEvent,
  type MatchState,
  NO_INPUT,
  type Player,
  PLAYER_R,
  PLAYERS_PER_TEAM,
  shotArea,
  type ShotArea,
  SPRINT_AT,
  type Team,
  CHARGE_TIME,
  chargeToPower,
  FIREBALL,
} from './types';

export const WALK = 6.2;
export const SPRINT = 8.4;
export const DRIBBLE_MULT = 0.9;
const PICKUP = 1.15;
const TACKLE = 1.2;

export interface MatchConfig {
  /** Match length in seconds of play. */
  duration: number;
  /** 0 easy, 1 normal, 2 hard (computer-controlled players). */
  difficulty: number;
  seed: number;
}

export interface Human {
  slot: number;
  team: Team;
  name: string;
  controlled: number;
  prev: Input;
  /** Seconds SHOOT has been held while on the ball, or -1 when not charging. */
  charge: number;
}

/** Formation in team coordinates (attacking +y). Index = role. */
export const FORMATION: { x: number; y: number }[] = [
  { x: 0, y: -28.6 },
  { x: -8, y: -17 },
  { x: 8, y: -17 },
  { x: -10, y: -5 },
  { x: 10, y: -5 },
  { x: 0, y: 6 },
];

/** Converts between pitch coordinates and "team" coordinates (team always attacks +y). */
export function toTeam(team: Team, x: number, y: number): { x: number; y: number } {
  return team === 0 ? { x, y } : { x: -x, y: -y };
}

export class MatchSim {
  readonly players: Player[] = [];
  readonly ball: Ball = { x: 0, y: 0, vx: 0, vy: 0, z: 0, owner: -1, lastTouch: -1, passTarget: -1 };
  readonly score: [number, number] = [0, 0];
  readonly humans = new Map<number, Human>();
  readonly rng: Rng;
  clock: number;
  state: MatchState = 'kickoff';
  stateT = 0;
  tick = 0;
  duel: Duel | null = null;
  kickoffTeam: Team = 0;
  /** Per-player seconds during which they cannot pick up the ball (after kicking it). */
  readonly noPickup: number[] = [];
  /** Per-player AI timers. */
  readonly aiTimer: number[] = [];
  /** Seconds of continuous contact each player has with the ball carrier. */
  readonly contact: number[] = [];
  /** How long the goalkeeper has been holding the ball. */
  keeperHold = 0;
  private events: MatchEvent[] = [];

  constructor(readonly cfg: MatchConfig) {
    this.rng = new Rng(cfg.seed);
    this.clock = cfg.duration;
    for (let t = 0 as Team; t <= 1; t = (t + 1) as Team) {
      for (let role = 0; role < PLAYERS_PER_TEAM; role++) {
        this.players.push({
          team: t,
          role,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          fx: 0,
          fy: t === 0 ? 1 : -1,
          sprinting: false,
          tackleCd: 0,
          protect: 0,
          human: -1,
        });
        this.noPickup.push(0);
        this.aiTimer.push(0);
        this.contact.push(0);
      }
    }
    this.setupKickoff(0);
  }

  // --- humans ------------------------------------------------------------------------------

  addHuman(slot: number, team: Team, name: string): void {
    this.humans.set(slot, { slot, team, name, controlled: -1, prev: NO_INPUT, charge: -1 });
    this.assignControl(true);
  }

  removeHuman(slot: number): void {
    const h = this.humans.get(slot);
    if (h && h.controlled >= 0) this.players[h.controlled].human = -1;
    this.humans.delete(slot);
  }

  teamHasHuman(team: Team): boolean {
    for (const h of this.humans.values()) if (h.team === team) return true;
    return false;
  }

  // --- helpers ---------------------------------------------------------------------------------

  teamOf(i: number): Team {
    return this.players[i].team;
  }

  keeperOf(team: Team): number {
    return team * PLAYERS_PER_TEAM;
  }

  /** Team in possession, or -1 when the ball is loose. Passes in flight count for the passer. */
  possession(): Team | -1 {
    if (this.ball.owner >= 0) return this.teamOf(this.ball.owner);
    if (this.ball.passTarget >= 0) return this.teamOf(this.ball.passTarget);
    return -1;
  }

  emit(e: MatchEvent): void {
    this.events.push(e);
  }

  private setupKickoff(team: Team): void {
    this.kickoffTeam = team;
    this.state = 'kickoff';
    this.stateT = 0;
    this.duel = null;
    this.keeperHold = 0;
    for (const p of this.players) {
      const f = FORMATION[p.role];
      let ty = Math.min(f.y, -1.5);
      if (p.role === 5) ty = p.team === team ? -0.7 : -9.5;
      const pos = toTeam(p.team, f.x * 0.9, ty);
      p.x = pos.x;
      p.y = pos.y;
      p.vx = p.vy = 0;
      p.fx = 0;
      p.fy = p.team === 0 ? 1 : -1;
      p.sprinting = false;
      p.tackleCd = 0;
      p.protect = 0;
    }
    const striker = team * PLAYERS_PER_TEAM + 5;
    Object.assign(this.ball, { x: 0, y: 0, vx: 0, vy: 0, z: 0, owner: striker, lastTouch: striker, passTarget: -1 });
    this.players[striker].protect = 1.5;
    this.assignControl(true);
  }

  // --- control assignment ------------------------------------------------------------------------

  /** Gives each human the most useful player: the ball carrier, the pass receiver, or the one nearest the ball. */
  assignControl(force = false): void {
    const taken = new Set<number>();
    for (const h of this.humans.values()) {
      const want = this.pickControlled(h, taken, force);
      if (want !== h.controlled) {
        if (h.controlled >= 0 && this.players[h.controlled].human === h.slot) this.players[h.controlled].human = -1;
        h.controlled = want;
        this.players[want].sprinting = false;
      }
      this.players[want].human = h.slot;
      taken.add(want);
    }
  }

  private pickControlled(h: Human, taken: Set<number>, force: boolean): number {
    const b = this.ball;
    const mine = (i: number) => i >= 0 && this.teamOf(i) === h.team && this.players[i].role !== 0 && !taken.has(i);
    if (mine(b.owner)) return b.owner;
    if (mine(b.passTarget)) return b.passTarget;
    let best = -1;
    let bestD = Infinity;
    for (let i = h.team * PLAYERS_PER_TEAM + 1; i < (h.team + 1) * PLAYERS_PER_TEAM; i++) {
      if (taken.has(i)) continue;
      const p = this.players[i];
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const cur = h.controlled;
    if (!force && mine(cur)) {
      // Hysteresis: only switch when someone is clearly closer, so control doesn't flicker.
      const cp = this.players[cur];
      const cd = Math.hypot(cp.x - b.x, cp.y - b.y);
      if (cd < bestD + 4) return cur;
    }
    return best;
  }

  // --- actions ---------------------------------------------------------------------------------

  kick(i: number, vx: number, vy: number, passTarget = -1): void {
    const b = this.ball;
    b.owner = -1;
    b.lastTouch = i;
    b.passTarget = passTarget;
    b.vx = vx;
    b.vy = vy;
    this.noPickup[i] = 0.3;
    this.emit({ type: 'kick', x: b.x, y: b.y, power: Math.hypot(vx, vy) });
  }

  /** Passes following the classic rules: no direction = nearest, direction = nearest in that direction, over-extended = farthest. */
  pass(i: number, dx: number, dy: number, forceTarget = -1): void {
    const p = this.players[i];
    let target = forceTarget;
    if (target < 0) {
      const mates: number[] = [];
      for (let j = p.team * PLAYERS_PER_TEAM + 1; j < (p.team + 1) * PLAYERS_PER_TEAM; j++) if (j !== i) mates.push(j);
      const dist = (j: number) => Math.hypot(this.players[j].x - p.x, this.players[j].y - p.y);
      const mag = Math.hypot(dx, dy);
      if (mag < 0.2) target = mates.reduce((a, b) => (dist(a) < dist(b) ? a : b));
      else {
        const ux = dx / mag;
        const uy = dy / mag;
        const cone = mates.filter((j) => {
          const q = this.players[j];
          const d = dist(j) || 1;
          return ((q.x - p.x) * ux + (q.y - p.y) * uy) / d > 0.64; // within ~50 degrees
        });
        if (!cone.length) target = mates.reduce((a, b) => (dist(a) < dist(b) ? a : b));
        else if (mag >= SPRINT_AT) target = cone.reduce((a, b) => (dist(a) > dist(b) ? a : b));
        else target = cone.reduce((a, b) => (dist(a) < dist(b) ? a : b));
      }
    }
    const q = this.players[target];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    const speed = Math.max(11, Math.min(22, 9 + d * 0.55));
    const t = d / speed;
    const aimX = q.x + q.vx * t * 0.8;
    const aimY = q.y + q.vy * t * 0.8;
    const ad = Math.hypot(aimX - this.ball.x, aimY - this.ball.y) || 1;
    this.kick(i, ((aimX - this.ball.x) / ad) * speed, ((aimY - this.ball.y) / ad) * speed, target);
    this.emit({ type: 'pass', from: i, to: target });
  }

  /** Starts a shot. Returns false if the player is too far (own half). */
  shoot(i: number, col: -1 | 0 | 1, high: boolean, power = 0.7): boolean {
    const p = this.players[i];
    const area = shotArea(p.team, p.x, p.y);
    if (area === 'own') return false;
    const zone: Zone = { col, row: high ? 1 : 0 };
    const tx = col * (GOAL_HALF - 0.55) + (this.rng.next() - 0.5) * 0.4;
    const ty = attackGoalY(p.team);
    const defending = (1 - p.team) as Team;
    // Shown in slow motion: harder shots still arrive sooner and leave less time to react.
    const speed = 12 + 18 * power;
    const dist = Math.hypot(tx - this.ball.x, ty - this.ball.y);
    const ticks = Math.round(Math.max(22, Math.min(75, (dist / speed) * 60 * 1.8)));
    this.duel = {
      shooter: i,
      team: p.team,
      area,
      zone,
      tx,
      ty,
      sx: this.ball.x,
      sy: this.ball.y,
      tick: 0,
      power,
      ticks,
      window: Math.max(14, Math.round(ticks * 0.72)),
      dive: undefined,
      keeperHuman: this.teamHasHuman(defending),
      outcome: null,
    };
    this.ball.owner = -1;
    this.ball.passTarget = -1;
    this.ball.lastTouch = i;
    this.state = 'duel';
    this.stateT = 0;
    this.emit({ type: 'kick', x: this.ball.x, y: this.ball.y, power: 14 + 16 * power });
    this.emit({ type: 'shot', by: i, area });
    return true;
  }

  // --- main step ---------------------------------------------------------------------------------

  /** Advances one tick. `inputs` maps human slot -> input. Returns the events of this tick. */
  step(inputs: ReadonlyMap<number, Input> = new Map()): MatchEvent[] {
    this.events = [];
    this.tick++;
    this.stateT += DT;
    switch (this.state) {
      case 'kickoff':
        // Everyone holds their kickoff position until the whistle.
        this.stickBall();
        if (this.stateT > 1.0) {
          this.state = 'play';
          this.stateT = 0;
          this.emit({ type: 'whistle', long: false });
        }
        break;
      case 'play':
        this.clock -= DT;
        if (this.clock <= 0) {
          this.clock = 0;
          this.state = 'ended';
          this.emit({ type: 'whistle', long: true });
          break;
        }
        if (this.tick % 6 === 0) this.assignControl();
        this.handleHumanActions(inputs);
        this.movePlayers(inputs, false);
        this.updateBall();
        this.tackles();
        this.keeperDistribution();
        break;
      case 'duel':
        this.updateDuel(inputs);
        break;
      case 'goal':
        this.movePlayers(new Map(), true);
        if (this.stateT > 2.4) {
          if (this.clock <= 0) this.state = 'ended';
          else this.setupKickoff(this.kickoffTeam);
        }
        break;
      case 'ended':
        break;
    }
    for (const h of this.humans.values()) h.prev = inputs.get(h.slot) ?? NO_INPUT;
    return this.events;
  }

  private handleHumanActions(inputs: ReadonlyMap<number, Input>): void {
    for (const h of this.humans.values()) {
      const inp = inputs.get(h.slot) ?? NO_INPUT;
      const passPressed = inp.pass && !h.prev.pass;
      const shootPressed = inp.shoot && !h.prev.shoot;
      const i = h.controlled;
      if (i < 0) continue;
      if (this.ball.owner !== i) h.charge = -1;
      if (this.ball.owner === i) {
        if (passPressed && h.charge < 0) {
          this.pass(i, inp.mx, inp.my);
          this.assignControl(true);
        } else if (shootPressed) {
          // Hold SHOOT to charge: the longer, the harder.
          h.charge = 0;
        } else if (h.charge >= 0 && inp.shoot) {
          h.charge += DT;
        } else if (h.charge >= 0 && !inp.shoot) {
          // Released: the held stick direction picks the side, pushed to the edge goes high.
          const col = inp.mx > 0.35 ? 1 : inp.mx < -0.35 ? -1 : 0;
          const power = chargeToPower(h.charge);
          h.charge = -1;
          if (!this.shoot(i, col, Math.hypot(inp.mx, inp.my) >= SPRINT_AT, power)) this.emit({ type: 'bounce' });
          if (this.state !== 'play') return;
        }
      } else if (passPressed) {
        // Without the ball, PASS switches to the player nearest the ball.
        h.controlled = -1;
        this.players[i].human = -1;
        this.assignControl(true);
      }
    }
  }

  /** How charged a player's shot is (0..1), or -1 if they are not charging. */
  chargeOf(i: number): number {
    const p = this.players[i];
    if (p.human < 0) return -1;
    const h = this.humans.get(p.human);
    return h && h.charge >= 0 ? Math.min(1, h.charge / CHARGE_TIME) : -1;
  }

  /** Alternates which team is processed first each tick, so neither side gets a systematic edge. */
  order(): number[] {
    const n = this.players.length;
    const first = this.tick % 2;
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push((k + first * PLAYERS_PER_TEAM) % n);
    return out;
  }

  private movePlayers(inputs: ReadonlyMap<number, Input>, formationOnly: boolean): void {
    const speedMult = [0.9, 1, 1.07][this.cfg.difficulty] ?? 1;
    // Phase 1: everyone decides from the same snapshot of the world.
    const want: { vx: number; vy: number }[] = new Array(this.players.length);
    for (const i of this.order()) {
      const p = this.players[i];
      p.tackleCd = Math.max(0, p.tackleCd - DT);
      p.protect = Math.max(0, p.protect - DT);
      this.noPickup[i] = Math.max(0, this.noPickup[i] - DT);
      let dvx = 0;
      let dvy = 0;
      if (p.human >= 0 && !formationOnly) {
        const inp = inputs.get(p.human) ?? NO_INPUT;
        const mag = Math.hypot(inp.mx, inp.my);
        const carry = this.ball.owner === i ? DRIBBLE_MULT : 1;
        if (mag >= SPRINT_AT) {
          // Sprint: direction is locked until the stick is released from the edge.
          if (!p.sprinting) {
            p.sprinting = true;
            p.fx = inp.mx / mag;
            p.fy = inp.my / mag;
          }
          dvx = p.fx * SPRINT * carry;
          dvy = p.fy * SPRINT * carry;
        } else {
          p.sprinting = false;
          dvx = inp.mx * WALK * carry;
          dvy = inp.my * WALK * carry;
        }
      } else {
        const t = aiThink(this, i, formationOnly);
        // Difficulty only changes the computer's team.
        const mult = this.teamHasHuman(p.team) ? 1 : speedMult;
        dvx = t.vx * mult;
        dvy = t.vy * mult;
        p.sprinting = Math.hypot(dvx, dvy) > WALK + 0.5;
      }
      want[i] = { vx: dvx, vy: dvy };
    }
    // Phase 2: move.
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const { vx: dvx, vy: dvy } = want[i];
      const k = Math.min(1, 10 * DT);
      p.vx += (dvx - p.vx) * k;
      p.vy += (dvy - p.vy) * k;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.4 && !(p.human >= 0 && p.sprinting)) {
        p.fx = p.vx / sp;
        p.fy = p.vy / sp;
      }
      const lim = p.role === 0 ? HALF_L - 0.3 : HALF_L - PLAYER_R;
      p.x = Math.max(-HALF_W + PLAYER_R, Math.min(HALF_W - PLAYER_R, p.x));
      p.y = Math.max(-lim, Math.min(lim, p.y));
    }
    // Keep players from overlapping.
    for (let a = 0; a < this.players.length; a++) {
      for (let b = a + 1; b < this.players.length; b++) {
        const pa = this.players[a];
        const pb = this.players[b];
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const d = Math.hypot(dx, dy);
        const min = PLAYER_R * 2;
        if (d > 0 && d < min) {
          const push = (min - d) / 2;
          pa.x -= (dx / d) * push;
          pa.y -= (dy / d) * push;
          pb.x += (dx / d) * push;
          pb.y += (dy / d) * push;
        }
      }
    }
  }

  private stickBall(): void {
    const b = this.ball;
    if (b.owner < 0) return;
    const p = this.players[b.owner];
    b.x = p.x + p.fx * (PLAYER_R + 0.3);
    b.y = p.y + p.fy * (PLAYER_R + 0.3);
    b.vx = p.vx;
    b.vy = p.vy;
    b.z = 0;
  }

  private updateBall(): void {
    const b = this.ball;
    if (b.owner >= 0) {
      this.stickBall();
      return;
    }
    // Rolling friction.
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const ns = Math.max(0, sp * (1 - 0.6 * DT) - 3.2 * DT);
      b.vx *= ns / sp;
      b.vy *= ns / sp;
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z = 0;

    // Walls (arcade: the ball stays in play), except the goal mouths.
    if (Math.abs(b.x) > HALF_W - 0.25) {
      b.x = Math.sign(b.x) * (HALF_W - 0.25);
      b.vx = -b.vx * 0.6;
      this.emit({ type: 'bounce' });
    }
    if (Math.abs(b.y) > HALF_L - 0.25) {
      if (Math.abs(b.x) < GOAL_HALF) {
        // A loose ball rolling over the line between the posts is a goal (own goals too).
        const scorer = (b.y > 0 ? 0 : 1) as Team;
        this.goalScored(scorer, b.lastTouch);
        return;
      }
      b.y = Math.sign(b.y) * (HALF_L - 0.25);
      b.vy = -b.vy * 0.6;
      this.emit({ type: 'bounce' });
    }

    // Pick-up: the nearest player who is close enough and allowed.
    let best = -1;
    let bestD = PICKUP;
    for (const i of this.order()) {
      if (this.noPickup[i] > 0) continue;
      const p = this.players[i];
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      const reach = p.role === 0 ? PICKUP + 0.4 : PICKUP;
      if (d < reach && d < bestD + (p.role === 0 ? 0.4 : 0)) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      const passer = b.lastTouch;
      if (passer >= 0 && this.teamOf(passer) !== this.teamOf(best)) this.emit({ type: 'steal', by: best });
      b.owner = best;
      b.passTarget = -1;
      b.lastTouch = best;
      this.players[best].protect = 0.6;
      if (this.players[best].role === 0) this.keeperHold = 0;
      this.stickBall();
      this.assignControl(true);
    }
  }

  private tackles(): void {
    const o = this.ball.owner;
    if (o < 0) return;
    const owner = this.players[o];
    if (owner.protect > 0 || owner.role === 0) return;
    for (const i of this.order()) {
      const p = this.players[i];
      if (p.team === owner.team || p.tackleCd > 0) continue;
      if (Math.hypot(p.x - owner.x, p.y - owner.y) >= TACKLE) this.contact[i] = 0;
      if (Math.hypot(p.x - owner.x, p.y - owner.y) < TACKLE) {
        // A tackle needs a moment of sustained contact, so a quick pass or turn escapes it.
        this.contact[i] += DT;
        if (this.contact[i] < 0.22) continue;
        this.contact.fill(0);
        this.ball.owner = i;
        this.ball.lastTouch = i;
        p.protect = 0.9;
        owner.tackleCd = 1.4;
        this.emit({ type: 'steal', by: i });
        this.stickBall();
        this.assignControl(true);
        return;
      }
    }
  }

  private keeperDistribution(): void {
    const o = this.ball.owner;
    if (o < 0 || this.players[o].role !== 0) return;
    this.keeperHold += DT;
    if (this.keeperHold > 0.9) {
      const team = this.teamOf(o);
      // Throw to the most open outfield teammate.
      let best = -1;
      let bestScore = -Infinity;
      for (let j = team * PLAYERS_PER_TEAM + 1; j < (team + 1) * PLAYERS_PER_TEAM; j++) {
        const q = this.players[j];
        let open = 10;
        for (const e of this.players) if (e.team !== team) open = Math.min(open, Math.hypot(e.x - q.x, e.y - q.y));
        const d = Math.hypot(q.x - this.players[o].x, q.y - this.players[o].y);
        const score = open - Math.max(0, d - 18) * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      this.pass(o, 0, 0, best);
      this.keeperHold = 0;
    }
  }

  // --- shots ----------------------------------------------------------------------------------

  private updateDuel(inputs: ReadonlyMap<number, Input>): void {
    const d = this.duel!;
    d.tick++;
    const defending = (1 - d.team) as Team;
    const keeper = this.players[this.keeperOf(defending)];

    if (d.dive === undefined) {
      if (d.keeperHuman) {
        for (const h of this.humans.values()) {
          if (h.team !== defending) continue;
          const dv = (inputs.get(h.slot) ?? NO_INPUT).dive;
          if (dv >= 0) {
            d.dive = dv >= 6 ? null : ZONES[dv];
            break;
          }
        }
      } else if (d.tick === Math.max(6, Math.round(d.ticks * 0.3))) d.dive = this.aiDive(d);
      if (d.dive === undefined && d.tick >= d.window) {
        // Time's up: a human keeper dives where their stick is pointing (or stays if it's centred).
        d.dive = null;
        for (const h of this.humans.values()) {
          if (h.team !== defending) continue;
          const inp = inputs.get(h.slot) ?? NO_INPUT;
          const mag = Math.hypot(inp.mx, inp.my);
          if (mag > 0.3) d.dive = { col: inp.mx > 0.35 ? 1 : inp.mx < -0.35 ? -1 : 0, row: mag >= SPRINT_AT ? 1 : 0 };
          break;
        }
      }
    }

    // Ball travels to the goal; players freeze (slow-motion moment).
    const k = Math.min(1, d.tick / d.ticks);
    this.ball.x = d.sx + (d.tx - d.sx) * k;
    this.ball.y = d.sy + (d.ty - d.sy) * k;
    this.ball.z = (d.zone.row ? 2.0 : 0.4) * Math.sin(k * Math.PI * 0.5) * (d.zone.row ? 1 : 0.6);
    if (d.dive !== undefined) {
      const tx = d.dive === null ? 0 : d.dive.col * (GOAL_HALF - 0.8);
      keeper.x += (tx - keeper.x) * 0.25;
      keeper.y += (d.ty - Math.sign(d.ty) * 0.6 - keeper.y) * 0.25;
    }

    if (d.tick >= d.ticks) {
      d.outcome = resolveDuel(d.area, d.zone, d.dive ?? null, d.power);
      if (d.outcome === 'goal') this.goalScored(d.team, d.shooter);
      else {
        this.emit({ type: 'save', by: this.keeperOf(defending) });
        const ki = this.keeperOf(defending);
        Object.assign(this.ball, { owner: ki, lastTouch: ki, passTarget: -1, vx: 0, vy: 0, z: 0 });
        this.keeperHold = 0;
        this.players[ki].protect = 1;
        this.state = 'play';
        this.stateT = 0;
        this.stickBall();
        this.assignControl(true);
      }
    }
  }

  /** Computer keeper guesses; harder difficulty reads shots better. */
  private aiDive(d: Duel): Zone {
    const base = d.area === 'long' ? 0.55 : d.area === 'danger' ? 0.5 : 0.3;
    // Harder shots are harder to read.
    const pCol = base + (this.cfg.difficulty - 1) * 0.08 - (d.power - 0.6) * 0.3;
    const col = this.rng.chance(pCol)
      ? d.zone.col
      : (([-1, 0, 1] as const).filter((c) => c !== d.zone.col)[this.rng.int(0, 1)] as -1 | 0 | 1);
    const row = this.rng.chance(0.6) ? d.zone.row : ((1 - d.zone.row) as 0 | 1);
    return { col, row };
  }

  private goalScored(team: Team, by: number): void {
    this.score[team]++;
    this.state = 'goal';
    this.stateT = 0;
    this.ball.owner = -1;
    this.ball.passTarget = -1;
    this.ball.vx = this.ball.vy = 0;
    this.kickoffTeam = (1 - team) as Team;
    this.emit({ type: 'goal', team, by });
  }
}

/**
 * Shot rules (from the original design, plus shot power):
 * - six-yard box ("impossible area"): always a goal;
 * - penalty box ("danger area"): keeper must match direction AND height;
 * - outside the box ("long area"): keeper must match direction; shots down the middle are
 *   saved, and so are weak (barely charged) shots, unless it's a full-power fireball.
 */
export function resolveDuel(area: ShotArea, zone: Zone, dive: Zone | null, power = 0.7): 'goal' | 'saved' {
  if (area === 'impossible') return 'goal';
  const k: Zone = dive ?? { col: 0, row: 0 };
  if (area === 'long') {
    if (power < 0.45) return 'saved';
    if (zone.col === 0 && power < FIREBALL) return 'saved';
    return k.col === zone.col ? 'saved' : 'goal';
  }
  return k.col === zone.col && k.row === zone.row ? 'saved' : 'goal';
}
