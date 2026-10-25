// The authoritative 7v7 match simulation. Runs on the host (or locally vs the computer).
// Fixed 60 Hz tick. Clients never run this: they only send inputs and draw snapshots.

import { Rng } from '../core/rng';
import { type Zone, ZONES } from '../duel/goal';
import { aiThink } from './ai';
import {
  attackGoalY,
  type Ball,
  DISC_R,
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
  isLongBall,
  LONG_BALL_RANGE,
  PASS_TAP,
  passCharge,
} from './types';

export const WALK = 6.9;
export const SPRINT = 10.3;
/** A sprint with the ball is this much slower: a defender without it can catch the carrier. */
export const DRIBBLE_MULT = 0.8;
/** Top speed of your player when not sprinting (the computer moves at WALK)... */
export const JOG = 8.5;
/** ...and with the ball: slower, but still under a sprint with it. */
export const DRIBBLE_JOG = 7.2;
/** How fast (rad/s) a sprint can turn: wider than walking, which turns at once. Wider still with the ball. */
const SPRINT_TURN = 4.5;
const SPRINT_TURN_BALL = 3;
const PICKUP = 1.15;
/** Touching the ball carrier takes the ball: as soon as the drawn discs meet, so what you see is what counts. */
const TACKLE = DISC_R * 2 + 0.1;
/** Whoever wins the ball (a tackle or picking it up) can't be tackled for this long (seconds): time to get away. */
const STEAL_GUARD = 0.5;
/**
 * The loser can't touch the ball (tackle or pick it up) for this long, and can't tackle at all until
 * they have stepped off the winner: otherwise the two stay touching and the ball flips straight back.
 */
const RETACKLE = 0.5;
/** The player who lost the ball stops dead with no control for this long (seconds), so the winner gets away. */
const STUN = 0.35;
/** Rolling friction: dv/dt = -(FRICTION_K * v + FRICTION_C). */
const FRICTION_K = 0.6;
const FRICTION_C = 3.2;
const GRAVITY = 12;
/** Every ground pass travels at this speed (m/s), whatever the distance, until someone takes it. */
export const PASS_SPEED = 17.5;
/** Control moves from the passer to the receiver this many seconds before the ball gets there. */
const SWITCH_BEFORE = 0.3;
/** A first-time shot is struck as soon as the incoming pass is this close to the receiver (m): before it is controlled. */
const STRIKE_REACH = 1.8;
/** How fast (rad/s) a long ball bends towards its receiver while in the air. */
const HOMING = 1.6;
/** Holding PASS without the ball for longer than this makes your player chase it. */
const CHASE_HOLD = 0.2;
/** Seconds after the whistle before an idle human's kickoff is taken for them. */
const KICKOFF_AUTO = 5;

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
  /** Seconds PASS has been held since it was pressed, or -1 when it isn't. */
  passHold: number;
  /** Whether the held PASS started on the ball (a pass on release) or off it (switch / chase). */
  passWithBall: boolean;
  /** A shot let go while our pass was still coming: struck first time when the ball arrives. */
  strike: { col: -1 | 0 | 1; high: boolean; power: number } | null;
  /** Seconds during which control won't switch on its own (after a manual switch). */
  lockSwitch: number;
  wasChasing: boolean;
}

/** Formation in team coordinates (attacking +y). Index = role. */
export const FORMATION: { x: number; y: number }[] = [
  { x: 0, y: -HALF_L + 1.4 },
  { x: -9, y: -19 },
  { x: 9, y: -19 },
  { x: -11, y: -5.5 },
  { x: 11, y: -5.5 },
  { x: 0, y: 6.5 },
  // Central midfielder, between the defenders and the wide men.
  { x: 0, y: -10 },
];

/** Converts between pitch coordinates and "team" coordinates (team always attacks +y). */
export function toTeam(team: Team, x: number, y: number): { x: number; y: number } {
  return team === 0 ? { x, y } : { x: -x, y: -y };
}

export class MatchSim {
  readonly players: Player[] = [];
  readonly ball: Ball = { x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0, flying: false, owner: -1, lastTouch: -1, passTarget: -1 };
  /** The receiver's velocity when the last pass was played: the run it was aimed into. */
  passRun = { x: 0, y: 0 };
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
  /** How long the goalkeeper has been holding the ball. */
  keeperHold = 0;
  private kickoffWhistle = false;
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
          stun: 0,
          human: -1,
        });
        this.noPickup.push(0);
        this.aiTimer.push(0);
      }
    }
    this.setupKickoff(0);
  }

  // --- humans ------------------------------------------------------------------------------

  addHuman(slot: number, team: Team, name: string): void {
    this.humans.set(slot, {
      slot,
      team,
      name,
      controlled: -1,
      prev: NO_INPUT,
      charge: -1,
      passHold: -1,
      passWithBall: false,
      strike: null,
      lockSwitch: 0,
      wasChasing: false,
    });
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
    this.kickoffWhistle = false;
    for (const h of this.humans.values()) {
      h.charge = -1;
      h.passHold = -1;
      h.lockSwitch = 0;
    }
    for (const p of this.players) {
      const f = FORMATION[p.role];
      let tx = f.x * 0.9;
      let ty = Math.min(f.y, -1.5);
      // The other team's striker waits just outside the centre circle, in front of their midfielder.
      if (p.role === 5) ty = p.team === team ? -0.7 : -6;
      if (p.role === 4 && p.team === team) {
        // The kickoff partner stands beside the taker: the first touch is a pass to them.
        tx = 3.2;
        ty = -1.2;
      }
      const pos = toTeam(p.team, tx, ty);
      p.x = pos.x;
      p.y = pos.y;
      p.vx = p.vy = 0;
      p.fx = 0;
      p.fy = p.team === 0 ? 1 : -1;
      p.sprinting = false;
      p.tackleCd = 0;
      p.protect = 0;
      p.stun = 0;
    }
    const striker = team * PLAYERS_PER_TEAM + 5;
    Object.assign(this.ball, {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      z: 0,
      vz: 0,
      flying: false,
      owner: striker,
      lastTouch: striker,
      passTarget: -1,
    });
    this.players[striker].protect = 1.5;
    this.assignControl(true);
  }

  // --- control assignment ------------------------------------------------------------------------

  /** Gives each human the most useful player: the ball carrier, the pass receiver, or the one nearest the ball. */
  assignControl(force = false): void {
    const taken = new Set<number>();
    for (const h of this.humans.values()) {
      const want = this.pickControlled(h, taken, force);
      this.setControl(h, want);
      taken.add(want);
    }
  }

  private setControl(h: Human, want: number): void {
    if (want !== h.controlled) {
      if (h.controlled >= 0 && this.players[h.controlled].human === h.slot) this.players[h.controlled].human = -1;
      h.controlled = want;
      this.players[want].sprinting = false;
    }
    this.players[want].human = h.slot;
  }

  private pickControlled(h: Human, taken: Set<number>, force: boolean): number {
    const b = this.ball;
    const mine = (i: number) => i >= 0 && this.teamOf(i) === h.team && this.players[i].role !== 0 && !taken.has(i);
    if (mine(b.owner)) return b.owner;
    if (b.passTarget >= 0 && this.teamOf(b.passTarget) === h.team) {
      // Our pass on its way: stay on the passer until it is about to reach the receiver.
      if (mine(b.passTarget) && this.passArriving()) return b.passTarget;
      if (mine(h.controlled)) return h.controlled;
    }
    // Just picked by hand, or chasing the ball: keep that player.
    if (mine(h.controlled) && (h.lockSwitch > 0 || this.chasing(h))) return h.controlled;
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

  /** PASS tapped without the ball: take the teammate nearest the ball (the next nearest if that's you already). */
  private switchPlayer(h: Human): void {
    const b = this.ball;
    const taken = new Set<number>();
    for (const o of this.humans.values()) if (o !== h && o.controlled >= 0) taken.add(o.controlled);
    const mates: number[] = [];
    for (let j = h.team * PLAYERS_PER_TEAM + 1; j < (h.team + 1) * PLAYERS_PER_TEAM; j++) if (!taken.has(j)) mates.push(j);
    const dist = (j: number) => Math.hypot(this.players[j].x - b.x, this.players[j].y - b.y);
    mates.sort((a, c) => dist(a) - dist(c));
    const next = mates[0] === h.controlled && mates.length > 1 ? mates[1] : mates[0];
    if (next === undefined) return;
    this.setControl(h, next);
    h.lockSwitch = 1.5;
  }

  /** Whether a human is holding PASS off the ball, so their player runs at it. */
  chasing(h: Human): boolean {
    return h.passHold >= CHASE_HOLD && !h.passWithBall && this.possession() !== h.team;
  }

  /** Where a pass receiver goes to meet the ball: where a lofted ball comes down, else a step towards it. */
  receivePoint(): { x: number; y: number } {
    const b = this.ball;
    let t = 0.25;
    if (b.z > 0.05 || b.vz > 0) t = (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * b.z)) / GRAVITY;
    return {
      x: Math.max(-HALF_W + 1, Math.min(HALF_W - 1, b.x + b.vx * t)),
      y: Math.max(-HALF_L + 1, Math.min(HALF_L - 1, b.y + b.vy * t)),
    };
  }

  // --- actions ---------------------------------------------------------------------------------

  kick(i: number, vx: number, vy: number, passTarget = -1, vz = 0): void {
    const b = this.ball;
    b.owner = -1;
    b.lastTouch = i;
    b.passTarget = passTarget;
    b.vx = vx;
    b.vy = vy;
    b.vz = vz;
    b.flying = vz > 0;
    this.noPickup[i] = 0.3;
    this.emit({ type: 'kick', x: b.x, y: b.y, power: Math.hypot(vx, vy, vz) });
  }

  /**
   * Who a pass goes to: the nearest teammate in the stick direction (no direction = nearest of all).
   * A long ball (`range` metres) goes to the teammate in that direction whose distance best matches it.
   */
  passTargetFor(i: number, dx: number, dy: number, range = 0): number {
    const p = this.players[i];
    const mates: number[] = [];
    for (let j = p.team * PLAYERS_PER_TEAM + 1; j < (p.team + 1) * PLAYERS_PER_TEAM; j++) if (j !== i) mates.push(j);
    const dist = (j: number) => Math.hypot(this.players[j].x - p.x, this.players[j].y - p.y);
    let mag = Math.hypot(dx, dy);
    if (mag < 0.2) {
      if (!range) return mates.reduce((a, b) => (dist(a) < dist(b) ? a : b));
      // A long ball with the stick centred goes the way the player is facing.
      dx = p.fx;
      dy = p.fy;
      mag = Math.hypot(dx, dy) || 1;
    }
    const ux = dx / mag;
    const uy = dy / mag;
    const cos = (j: number) => ((this.players[j].x - p.x) * ux + (this.players[j].y - p.y) * uy) / (dist(j) || 1);
    // Lower is better. Slightly off-line teammates count as a bit farther away.
    const score = (j: number) => (range ? Math.abs(dist(j) - range) + 12 * (1 - cos(j)) : dist(j) * (1 + 2 * (1 - cos(j))));
    // Within 60 degrees of the stick, else anyone on that side, else whoever is most that way.
    for (const minCos of [0.5, 0]) {
      const ok = mates.filter((j) => cos(j) > minCos);
      if (ok.length) return ok.reduce((a, b) => (score(a) <= score(b) ? a : b));
    }
    return mates.reduce((a, b) => (cos(a) >= cos(b) ? a : b));
  }

  /**
   * Passes to a teammate (see passTargetFor): a ground pass at PASS_SPEED, or a lofted long ball to the far one.
   * Either way the ball keeps going for the receiver once it is on the ground: only an opponent can cut it out.
   */
  pass(i: number, dx: number, dy: number, forceTarget = -1, lofted = false): void {
    const target = forceTarget >= 0 ? forceTarget : this.passTargetFor(i, dx, dy, lofted ? LONG_BALL_RANGE : 0);
    const q = this.players[target];
    const b = this.ball;
    // Speed and flight time for a given distance.
    const plan = (d: number) => {
      if (lofted) {
        // Flies over defenders and comes down at the receiver's feet.
        const t = 0.75 + d * 0.016;
        return { speed: (d * 0.95) / t, vz: (GRAVITY * t) / 2, t };
      }
      return { speed: PASS_SPEED, vz: 0, t: d / PASS_SPEED };
    };
    // Played into the receiver's run: aimed where the ball meets them if they keep going.
    const t = lofted ? plan(Math.hypot(q.x - b.x, q.y - b.y)).t : this.interceptTime(target, PASS_SPEED);
    const { x: aimX, y: aimY } = this.leadPoint(target, t);
    const ad = Math.hypot(aimX - b.x, aimY - b.y) || 1;
    const { speed, vz } = plan(ad);
    this.passRun = { x: q.vx, y: q.vy };
    this.kick(i, ((aimX - b.x) / ad) * speed, ((aimY - b.y) / ad) * speed, target, vz);
    this.emit({ type: 'pass', from: i, to: target });
  }

  /** Seconds for a ball at `speed` to meet player j if they keep running as they are. */
  private interceptTime(j: number, speed: number): number {
    const q = this.players[j];
    const b = this.ball;
    const rx = q.x - b.x;
    const ry = q.y - b.y;
    const a = q.vx * q.vx + q.vy * q.vy - speed * speed;
    const rv = rx * q.vx + ry * q.vy;
    const c = rx * rx + ry * ry;
    // A receiver faster than the ball can't be met head-on: just aim at them.
    if (a > -1e-6) return Math.sqrt(c) / speed;
    return Math.min(3, (-rv - Math.sqrt(rv * rv - a * c)) / a);
  }

  /** Whether a pass is about to reach its receiver: control moves to them only then. */
  private passArriving(): boolean {
    const b = this.ball;
    const q = this.players[b.passTarget];
    return Math.hypot(q.x - b.x, q.y - b.y) < Math.max(2.5, Math.hypot(b.vx, b.vy) * SWITCH_BEFORE);
  }

  /** Where player j will be in `t` seconds if they keep running, kept on the pitch. */
  private leadPoint(j: number, t: number): { x: number; y: number } {
    const q = this.players[j];
    return {
      x: Math.max(-HALF_W + 0.5, Math.min(HALF_W - 0.5, q.x + q.vx * t)),
      y: Math.max(-HALF_L + 0.5, Math.min(HALF_L - 0.5, q.y + q.vy * t)),
    };
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
    // Real time: harder shots arrive sooner and leave less time to react.
    // More charge, more speed: a tap (power 0.3) about 22 m/s, a full charge about 46 m/s.
    const speed = 12 + 34 * power;
    const dist = Math.hypot(tx - this.ball.x, ty - this.ball.y);
    const ticks = Math.round(Math.max(10, Math.min(48, (dist / speed) * 60)));
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
      window: Math.min(ticks, Math.max(11, Math.round(ticks * 0.75))),
      dive: undefined,
      keeperHuman: this.teamHasHuman(defending),
      outcome: null,
    };
    this.ball.owner = -1;
    this.ball.passTarget = -1;
    this.ball.lastTouch = i;
    this.ball.vz = 0;
    this.ball.flying = false;
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
        // Everyone holds their kickoff position until the whistle, then the taker passes to start play.
        this.stickBall();
        if (this.stateT > 1.0) {
          if (!this.kickoffWhistle) {
            this.kickoffWhistle = true;
            this.emit({ type: 'whistle', long: false });
          }
          this.takeKickoff(inputs);
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
        // Every tick while a pass is out, so control moves the moment it is about to arrive.
        if (this.tick % 6 === 0 || this.ball.passTarget >= 0) this.assignControl();
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

  /** After the whistle: the taker must pass. The computer does it at once; an idle human gets it done for them. */
  private takeKickoff(inputs: ReadonlyMap<number, Input>): void {
    const taker = this.ball.owner;
    if (taker < 0) return;
    const human = this.players[taker].human >= 0;
    if (human) this.handleHumanActions(inputs, true);
    const waited = this.stateT - 1.0;
    if (this.ball.owner === taker && waited > (human ? KICKOFF_AUTO : 0.5)) {
      this.pass(taker, 0, 0);
      this.assignControl(true);
    }
    if (this.ball.owner !== taker) {
      this.state = 'play';
      this.stateT = 0;
    }
  }

  private handleHumanActions(inputs: ReadonlyMap<number, Input>, kickoff = false): void {
    for (const h of this.humans.values()) {
      const inp = inputs.get(h.slot) ?? NO_INPUT;
      const passPressed = inp.pass && !h.prev.pass;
      const passReleased = !inp.pass && h.prev.pass;
      const shootPressed = inp.shoot && !h.prev.shoot;
      h.lockSwitch = Math.max(0, h.lockSwitch - DT);
      const b = this.ball;
      // Our ground pass on its way: SHOOT takes the receiver at once, for a first-time shot.
      const ours = !kickoff && b.owner < 0 && b.passTarget >= 0 && this.teamOf(b.passTarget) === h.team;
      const rq = ours ? this.players[b.passTarget] : null;
      if (rq && shootPressed && h.passHold < 0 && rq.role !== 0 && (rq.human < 0 || rq.human === h.slot)) {
        this.setControl(h, b.passTarget);
      }
      const i = h.controlled;
      if (i < 0) continue;
      const receiving = ours && b.passTarget === i;
      if (!receiving) h.strike = null;
      // PASS acts on release: a tap and a hold mean different things.
      const held = h.passHold;
      if (passPressed && h.charge < 0) {
        h.passHold = 0;
        h.passWithBall = this.ball.owner === i;
      } else if (inp.pass && h.passHold >= 0) h.passHold += DT;
      else if (!inp.pass) h.passHold = -1;
      if (this.ball.owner !== i && !receiving) h.charge = -1;
      if (receiving) {
        // Charge while the pass comes in. Released before it arrives: struck first time (see firstTimeStrike).
        if (shootPressed && h.passHold < 0) {
          h.charge = 0;
          h.strike = null;
        } else if (h.charge >= 0 && inp.shoot) {
          h.charge += DT;
        } else if (h.charge >= 0 && !inp.shoot) {
          const col = inp.mx > 0.35 ? 1 : inp.mx < -0.35 ? -1 : 0;
          h.strike = { col, high: Math.hypot(inp.mx, inp.my) >= SPRINT_AT, power: chargeToPower(h.charge) };
          h.charge = -1;
        }
      } else if (this.ball.owner === i) {
        if (passReleased && held >= 0 && h.passWithBall && h.charge < 0) {
          // Ground pass, unless PASS was held until the meter filled: then a long ball.
          this.pass(i, inp.mx, inp.my, -1, isLongBall(held));
          this.assignControl(true);
        } else if (kickoff) {
          continue;
        } else if (shootPressed && h.passHold < 0) {
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
      } else if (!kickoff && passReleased && held >= 0 && held < CHASE_HOLD && !h.passWithBall) {
        // Without the ball, a tap switches to the player nearest the ball (holding chases it, see movePlayers).
        if (this.possession() !== h.team) this.switchPlayer(h);
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

  /** How charged a player's long ball is (0..1), or -1 if they are not holding PASS on the ball. */
  passChargeOf(i: number): number {
    const p = this.players[i];
    if (p.human < 0 || this.ball.owner !== i) return -1;
    const h = this.humans.get(p.human);
    return h && h.passWithBall && h.passHold >= PASS_TAP ? passCharge(h.passHold) : -1;
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
      if (p.stun > 0) {
        // Just lost the ball: no control for a moment, so the winner gets away.
        p.stun = Math.max(0, p.stun - DT);
        p.sprinting = false;
      } else if (p.human >= 0 && !formationOnly) {
        const inp = inputs.get(p.human) ?? NO_INPUT;
        const h = this.humans.get(p.human);
        const mag = Math.hypot(inp.mx, inp.my);
        const carry = this.ball.owner === i ? DRIBBLE_MULT : 1;
        const b = this.ball;
        if (h && h.wasChasing && !this.chasing(h)) {
          // Chase over: a sprint now follows the stick, not the chase direction.
          h.wasChasing = false;
          p.sprinting = false;
        }
        if (h && this.chasing(h)) {
          // PASS held off the ball: sprint at the ball (or whoever has it, or where it comes down) to win it back.
          const o = b.owner >= 0 ? this.players[b.owner] : null;
          const land = b.flying ? this.receivePoint() : null;
          const tx = o ? o.x + o.vx * 0.15 : land ? land.x : b.x + b.vx * 0.3;
          const ty = o ? o.y + o.vy * 0.15 : land ? land.y : b.y + b.vy * 0.3;
          const d = Math.hypot(tx - p.x, ty - p.y);
          h.wasChasing = true;
          if (d > 0.1) {
            p.sprinting = true;
            p.fx = (tx - p.x) / d;
            p.fy = (ty - p.y) / d;
            dvx = p.fx * SPRINT;
            dvy = p.fy * SPRINT;
          }
        } else if (b.passTarget === i && b.owner < 0 && mag < 0.2) {
          // Receiving with the stick idle: step in to meet the ball.
          p.sprinting = false;
          const r = this.receivePoint();
          const d = Math.hypot(r.x - p.x, r.y - p.y);
          if (d > 0.3) {
            const s = b.z > 0.05 ? SPRINT : WALK;
            dvx = ((r.x - p.x) / d) * s;
            dvy = ((r.y - p.y) / d) * s;
          }
        } else if (mag >= SPRINT_AT) {
          // Sprint: steer with the stick held at the edge, turning wider than at a walk.
          const sx = inp.mx / mag;
          const sy = inp.my / mag;
          if (!p.sprinting) {
            p.sprinting = true;
            p.fx = sx;
            p.fy = sy;
          } else {
            const da = Math.atan2(p.fx * sy - p.fy * sx, p.fx * sx + p.fy * sy);
            const rate = (this.ball.owner === i ? SPRINT_TURN_BALL : SPRINT_TURN) * DT;
            const turn = Math.max(-rate, Math.min(rate, da));
            const c = Math.cos(turn);
            const s = Math.sin(turn);
            const fx = p.fx * c - p.fy * s;
            p.fy = p.fx * s + p.fy * c;
            p.fx = fx;
          }
          dvx = p.fx * SPRINT * carry;
          dvy = p.fy * SPRINT * carry;
        } else {
          p.sprinting = false;
          const jog = this.ball.owner === i ? DRIBBLE_JOG : JOG;
          dvx = inp.mx * jog;
          dvy = inp.my * jog;
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
      // A player who just lost the ball keeps facing the one who took it.
      if (sp > 0.4 && p.stun <= 0 && !(p.human >= 0 && p.sprinting)) {
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
        // A player who just lost the ball doesn't block anyone: the winner can run straight on with it.
        if (d > 0 && d < min && pa.stun <= 0 && pb.stun <= 0) {
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
    b.vz = 0;
  }

  private updateBall(): void {
    const b = this.ball;
    if (b.owner >= 0) {
      this.stickBall();
      return;
    }
    if (b.z > 0 || b.vz > 0) {
      // In the air: gravity, a small bounce on landing.
      b.vz -= GRAVITY * DT;
      b.z += b.vz * DT;
      if (b.z <= 0) {
        b.z = 0;
        b.flying = false;
        // A long ball drops dead for its receiver; anything else bounces.
        if (b.vz < -3 && b.passTarget < 0) {
          b.vz = -b.vz * 0.3;
          b.vx *= 0.8;
          b.vy *= 0.8;
        } else b.vz = 0;
      }
    } else if (b.passTarget < 0) {
      // Rolling friction.
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const ns = Math.max(0, sp * (1 - FRICTION_K * DT) - FRICTION_C * DT);
        b.vx *= ns / sp;
        b.vy *= ns / sp;
      }
    }
    if (b.passTarget >= 0 && !b.flying) {
      // A pass on the ground runs at a fixed pace straight for its receiver, wherever they go.
      const aim = this.leadPoint(b.passTarget, this.interceptTime(b.passTarget, PASS_SPEED));
      const d = Math.hypot(aim.x - b.x, aim.y - b.y);
      if (d > 0.05) {
        b.vx = ((aim.x - b.x) / d) * PASS_SPEED;
        b.vy = ((aim.y - b.y) / d) * PASS_SPEED;
      }
    } else if (b.passTarget >= 0) {
      // A long ball bends gently towards the receiver while it is in the air.
      const q = this.players[b.passTarget];
      const sp = Math.hypot(b.vx, b.vy);
      let da = Math.atan2(q.y - b.y, q.x - b.x) - Math.atan2(b.vy, b.vx);
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (sp > 1 && Math.abs(da) < 1.2) {
        const turn = Math.max(-HOMING * DT, Math.min(HOMING * DT, da));
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        const vx = b.vx * c - b.vy * s;
        b.vy = b.vx * s + b.vy * c;
        b.vx = vx;
      }
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;

    // Walls (arcade: the ball stays in play), except the goal mouths. A pass off the wall is a loose ball.
    if (Math.abs(b.x) > HALF_W - 0.25) {
      b.x = Math.sign(b.x) * (HALF_W - 0.25);
      b.vx = -b.vx * 0.6;
      b.passTarget = -1;
      this.emit({ type: 'bounce' });
    }
    if (Math.abs(b.y) > HALF_L - 0.25) {
      b.passTarget = -1;
      if (Math.abs(b.x) < GOAL_HALF && b.z < 2.4) {
        // A loose ball rolling over the line between the posts is a goal (own goals too).
        const scorer = (b.y > 0 ? 0 : 1) as Team;
        this.goalScored(scorer, b.lastTouch);
        return;
      }
      b.y = Math.sign(b.y) * (HALF_L - 0.25);
      b.vy = -b.vy * 0.6;
      this.emit({ type: 'bounce' });
    }

    // A long ball in the air can't be touched by anyone, teammates and keepers too, until it lands.
    if (b.flying) return;
    if (this.firstTimeStrike()) return;
    // Pick-up: the nearest player who is close enough and allowed. A pass is only for its receiver or an opponent.
    let best = -1;
    let bestD = PICKUP;
    const passTeam = b.passTarget >= 0 ? this.teamOf(b.passTarget) : -1;
    for (const i of this.order()) {
      if (this.noPickup[i] > 0) continue;
      if (this.teamOf(i) === passTeam && i !== b.passTarget) continue;
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
      this.players[best].protect = STEAL_GUARD;
      // Whoever has the ball can always run with it.
      this.players[best].stun = 0;
      if (this.players[best].role === 0) this.keeperHold = 0;
      this.stickBall();
      this.assignControl(true);
    }
  }

  /** A receiver who already let go of SHOOT hits the pass first time as it reaches them. Returns true if shot. */
  private firstTimeStrike(): boolean {
    const b = this.ball;
    if (b.passTarget < 0) return false;
    const q = this.players[b.passTarget];
    const h = q.human >= 0 ? this.humans.get(q.human) : undefined;
    if (!h || !h.strike || h.controlled !== b.passTarget) return false;
    if (Math.hypot(q.x - b.x, q.y - b.y) > STRIKE_REACH) return false;
    const s = h.strike;
    h.strike = null;
    // Too far out to shoot: they just take the ball as usual.
    if (!this.shoot(b.passTarget, s.col, s.high, s.power)) {
      this.emit({ type: 'bounce' });
      return false;
    }
    return true;
  }

  private tackles(): void {
    const o = this.ball.owner;
    if (o < 0) return;
    const owner = this.players[o];
    const guarded = owner.protect > 0 || owner.role === 0;
    for (const i of this.order()) {
      const p = this.players[i];
      if (p.team === owner.team) continue;
      const touching = Math.hypot(p.x - owner.x, p.y - owner.y) < TACKLE;
      if (p.tackleCd > 0) {
        // Still leaning on the carrier: the wait doesn't run out until they step away.
        if (touching) p.tackleCd = Math.max(p.tackleCd, DT * 2);
        continue;
      }
      if (touching && !guarded) {
        // A touch takes the ball. The loser just stops for a moment: no shove.
        this.ball.owner = i;
        this.ball.lastTouch = i;
        p.protect = STEAL_GUARD;
        // The loser can't touch the ball for a moment (no tackle, no picking up a pass): the winner gets away.
        owner.tackleCd = RETACKLE;
        this.noPickup[o] = RETACKLE;
        owner.vx = 0;
        owner.vy = 0;
        owner.stun = STUN;
        p.stun = 0;
        // The winner turns away with the ball instead of leaving it at the loser's feet.
        // If they keep running at the loser, they go straight through (see movePlayers).
        const d = Math.hypot(p.x - owner.x, p.y - owner.y) || 1;
        p.fx = (p.x - owner.x) / d;
        p.fy = (p.y - owner.y) / d;
        owner.sprinting = false;
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
      // Far teammates get a lofted ball over the press, and so does anyone when an opponent could cut out
      // a ball rolled along the ground: a save stays ours until the keeper's throw comes down.
      const k = this.players[o];
      const q = this.players[best];
      const far = Math.hypot(q.x - k.x, q.y - k.y) > 20;
      const lx = q.x - k.x;
      const ly = q.y - k.y;
      const ll = lx * lx + ly * ly || 1;
      const inTheWay = this.players.some((e) => {
        if (e.team === k.team) return false;
        const s = Math.max(0, Math.min(1, ((e.x - k.x) * lx + (e.y - k.y) * ly) / ll));
        return Math.hypot(e.x - k.x, e.y - k.y) < 7 || Math.hypot(k.x + lx * s - e.x, k.y + ly * s - e.y) < 3;
      });
      this.pass(o, 0, 0, best, far || inTheWay);
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
        Object.assign(this.ball, { owner: ki, lastTouch: ki, passTarget: -1, vx: 0, vy: 0, z: 0, vz: 0, flying: false });
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
    this.ball.vx = this.ball.vy = this.ball.vz = 0;
    this.ball.flying = false;
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
