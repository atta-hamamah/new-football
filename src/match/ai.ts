// Computer players. Every outfield player has a role (shirt number, see tactics.ts).
// Off the ball, in attack: each looks for open space around its role's spot (away from defenders,
// a clear lane from the ball, ground gained, room from teammates) and times runs in behind.
// In defence: the nearest presses, the next covers, the rest hold a compact block and mark the
// runner in their zone goal-side. On the ball: dribble, pass to the open man (into his run), shoot in range.

import type { MatchSim } from './sim';
import { FORMATION, PASS_SPEED, SPRINT, toTeam, WALK } from './sim';
import { type Job, TACTICS, type TacticDef } from './tactics';
import { DT, HALF_L, HALF_W, PLAYERS_PER_TEAM, shotArea, type Team } from './types';

export interface AiMove {
  vx: number;
  vy: number;
}

interface Pt {
  x: number;
  y: number;
}

/** Per-player memory for moving off the ball. */
export interface Brain {
  /** Seconds left of a run in behind, and until the next one may start. */
  run: number;
  cd: number;
  /** Where the run goes (team coordinates). */
  rx: number;
  ry: number;
}

export function newBrain(): Brain {
  return { run: 0, cd: 0, rx: 0, ry: 0 };
}

/** Where a team's players are heading off the ball. Re-made a few times a second, all roles together. */
export interface TeamPlan {
  tick: number;
  attacking: boolean;
  /** By role, pitch coordinates. */
  spot: Pt[];
  speed: number[];
}

export function newPlan(): TeamPlan {
  return {
    tick: -1e6,
    attacking: false,
    spot: Array.from({ length: PLAYERS_PER_TEAM }, () => ({ x: 0, y: 0 })),
    speed: new Array<number>(PLAYERS_PER_TEAM).fill(WALK),
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function seek(px: number, py: number, tx: number, ty: number, maxSpeed: number, slowRadius = 3): AiMove {
  const dx = tx - px;
  const dy = ty - py;
  const d = Math.hypot(dx, dy);
  if (d < 0.15) return { vx: 0, vy: 0 };
  const speed = d < slowRadius ? (maxSpeed * d) / slowRadius : maxSpeed;
  return { vx: (dx / d) * speed, vy: (dy / d) * speed };
}

/** Distance from e to the line a→b, or Infinity when e is not alongside it (behind a, or past b). */
function laneGap(ax: number, ay: number, bx: number, by: number, ex: number, ey: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = ((ex - ax) * dx + (ey - ay) * dy) / (dx * dx + dy * dy || 1);
  if (t < 0.08 || t > 1) return Infinity;
  return Math.hypot(ax + dx * t - ex, ay + dy * t - ey);
}

function nearestOpponent(sim: MatchSim, i: number): { j: number; d: number } {
  const p = sim.players[i];
  let j = -1;
  let d = Infinity;
  for (let k = 0; k < sim.players.length; k++) {
    const q = sim.players[k];
    if (q.team === p.team) continue;
    const dd = Math.hypot(q.x - p.x, q.y - p.y);
    if (dd < d) {
      d = dd;
      j = k;
    }
  }
  return { j, d };
}

/** Index of the team's outfield player (not human-controlled) closest to a point. */
function closestOutfield(sim: MatchSim, team: Team, x: number, y: number, exclude = -1): number {
  let best = -1;
  let bestD = Infinity;
  for (let k = team * PLAYERS_PER_TEAM + 1; k < (team + 1) * PLAYERS_PER_TEAM; k++) {
    if (k === exclude || sim.players[k].human >= 0) continue;
    const q = sim.players[k];
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** The deepest outfield opponent (team coordinates): a ball played beyond them is in behind. */
function lastLine(sim: MatchSim, team: Team): number {
  let line = -HALF_L;
  for (const e of sim.players) if (e.team !== team && e.role !== 0) line = Math.max(line, toTeam(team, e.x, e.y).y);
  return line;
}

/**
 * Scores pass options: open, forward, and not through an opponent. Each receiver is judged where
 * he will be when the ball gets there, so a runner is found in his stride (a through ball).
 * With the ground blocked, a direct team goes over the top (a long ball can't be touched until it lands).
 */
export function bestPass(sim: MatchSim, i: number): { j: number; score: number; lofted: boolean } {
  const p = sim.players[i];
  const team = p.team;
  const tac = TACTICS[sim.tactic[team]];
  const pt = toTeam(team, p.x, p.y);
  const line = lastLine(sim, team);
  let best = { j: -1, score: -Infinity, lofted: false };
  for (let j = team * PLAYERS_PER_TEAM + 1; j < (team + 1) * PLAYERS_PER_TEAM; j++) {
    if (j === i) continue;
    const q = sim.players[j];
    const t = Math.hypot(q.x - p.x, q.y - p.y) / PASS_SPEED;
    const lx = clamp(q.x + q.vx * t, -HALF_W + 1, HALF_W - 1);
    const ly = clamp(q.y + q.vy * t, -HALF_L + 1, HALF_L - 1);
    const d = Math.hypot(lx - p.x, ly - p.y);
    let open = 10;
    let lane = 10;
    for (const e of sim.players) {
      if (e.team === team) continue;
      open = Math.min(open, Math.hypot(e.x - lx, e.y - ly));
      // Whoever is marking the passer doesn't block: the ball is already past him when it leaves the foot.
      if (Math.hypot(e.x - p.x, e.y - p.y) < 1.8) continue;
      lane = Math.min(lane, laneGap(p.x, p.y, lx, ly, e.x, e.y));
    }
    const lt = toTeam(team, lx, ly);
    const run = toTeam(team, q.vx, q.vy);
    const through = run.y > 3 && lt.y > line ? tac.through : 0;
    // Ground gained is worth something, ground given back costs more: keeping the ball still means going forward.
    const gain = lt.y - pt.y;
    const fwd = gain * tac.passForward * (gain < 0 ? 1.5 : 1);
    const base = Math.min(open, 7) * 0.7 + fwd + through - Math.max(0, d - 22) * 0.4 - (d < 4 ? 2 : 0);
    // A longer pass gives a defender more time to step across: it needs a wider gap.
    const blocked = lane < 1.1 + d * 0.06;
    let score = base - (blocked ? 8 : 0);
    let lofted = false;
    if (tac.loft && blocked && d > 14 && d < 36 && open > 4 && lt.y - pt.y > 6 && base - 1.5 > score) {
      score = base - 1.5;
      lofted = true;
    }
    if (score > best.score) best = { j, score, lofted };
  }
  return best;
}

// --- off the ball: attack ---------------------------------------------------------------------

/** Roles in the order they pick their spots: forwards first, then the support fills in around them. */
const ATTACK_ORDER = [5, 3, 4, 6, 1, 2];

const RING = Array.from({ length: 8 }, (_, k) => ({ x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) }));

/**
 * A role's home in attack: its lane, slid towards the ball, at its depth in the team's shape.
 * The shape moves as one around the man on the ball: `c` is where the team's middle is, given where he
 * plays (a defender on the ball deep in his half has everyone else ahead of him; the striker on it, behind).
 */
function anchorFor(role: number, job: Job, h: Pt, c: number, line: number, opps: Pt[]): Pt {
  let lane = job.x;
  let ahead = job.ahead;
  let max = job.max;
  if (job.rest) {
    // The defender on the ball's side pushes on; the other tucks in to cover the middle.
    if (Math.sign(job.x) === Math.sign(h.x) && Math.abs(h.x) > 4) {
      ahead += job.overlap ?? 0;
      max += job.overlap ?? 0;
    } else lane *= 0.6;
  }
  let x = clamp(lane + (h.x - lane) * job.follow, -(HALF_W - 3), HALF_W - 3);
  let y = Math.min(clamp(c + ahead, h.y + job.min, h.y + max), job.top);
  // Near their box the forwards attack it: the 7 the near post, the far winger the far post,
  // the near winger stays wide for the ball down the line, the 4 waits at the edge for the cut-back.
  const box = BOX_SPOT[role]?.(h);
  const k = box ? clamp((h.y - 8) / 12, 0, 1) : 0;
  if (box && k > 0) {
    x += (box.x - x) * k;
    y += (Math.min(box.y, job.top) - y) * k;
  }
  if (job.rest) {
    // Behind the ball, and goal-side of any forward of theirs left up the pitch in this lane:
    // no free run at our goal on the counter.
    // Never so far back that the team splits in two, unless one of theirs is lurking back there.
    y = clamp(y, h.y - 13, h.y - 1.5);
    for (const o of opps) if (o.y < y + 2 && Math.abs(o.x - x) < 9) y = Math.min(y, o.y - 2.5);
    y = Math.max(y, -HALF_L + 7);
  } else {
    // Level with their last defender until it is time to run in behind.
    y = Math.min(y, line + 0.5);
  }
  return { x, y: clamp(y, -HALF_L + 5, HALF_L - 5) };
}

/** Where each attacking role goes when the ball is near the box we attack (by role; defenders stay put). */
const BOX_SPOT: (((h: Pt) => Pt) | null)[] = [
  null,
  null,
  null,
  (h) => (h.x < -4 ? { x: -13, y: Math.min(h.y + 3, HALF_L - 6) } : { x: -4, y: HALF_L - 6.5 }),
  (h) => (h.x > 4 ? { x: 13, y: Math.min(h.y + 3, HALF_L - 6) } : { x: 4, y: HALF_L - 6.5 }),
  (h) => ({ x: clamp(h.x * 0.3, -4, 4), y: HALF_L - 5.5 }),
  (h) => ({ x: clamp(h.x * 0.4, -6, 6), y: HALF_L - 12 }),
];

/** Where a run in behind goes: past their last defender, into the channel with the most room. */
function runTarget(job: Job, anchor: Pt, line: number, opps: Pt[]): Pt {
  const y = Math.min(HALF_L - 5, job.top + 3, line + 5 + 4 * job.runs);
  let best = anchor.x;
  let bestOpen = -1;
  // Straight on, diagonally inside, or into either channel.
  for (const x0 of [anchor.x, anchor.x * 0.5, anchor.x - 5, anchor.x + 5]) {
    const x = clamp(x0, -(HALF_W - 4), HALF_W - 4);
    let open = 99;
    for (const o of opps) open = Math.min(open, Math.hypot(o.x - x, o.y - y));
    if (open > bestOpen) {
      bestOpen = open;
      best = x;
    }
  }
  return { x: best, y };
}

interface SpotWorld {
  tac: TacticDef;
  /** The man on the ball (or our pass's receiver), and whether there is one. */
  h: Pt;
  hasHub: boolean;
  line: number;
  opps: Pt[];
  keeper: Pt;
  /** Spots teammates already hold or have claimed. */
  taken: Pt[];
}

/** How good a spot is for a player without the ball. */
function spotScore(w: SpotWorld, job: Job, anchor: Pt, prev: Pt, c: Pt): number {
  const { tac, h } = w;
  // Stay near the role's home: that keeps the shape (and the width) of the team.
  const da = Math.hypot(c.x - anchor.x, c.y - anchor.y);
  let s = -0.22 * da - 0.025 * da * da;
  // Room around it, where the defenders will be a moment from now.
  let open = 9;
  for (const o of w.opps) open = Math.min(open, Math.hypot(o.x - c.x, o.y - c.y));
  if (c.y > HALF_L - 9) open = Math.min(open, Math.hypot(w.keeper.x - c.x, w.keeper.y - c.y) + 1);
  s += tac.w.open * Math.min(open, 5) - (open < 2 ? 3 : 0);
  // A clear line for the pass.
  if (w.hasHub) {
    let lane = 9;
    for (const o of w.opps) {
      if (Math.hypot(o.x - h.x, o.y - h.y) < 1.5) continue;
      lane = Math.min(lane, laneGap(h.x, h.y, c.x, c.y, o.x, o.y));
    }
    s += tac.w.lane * Math.min(lane, 3.5) - (lane < 1.2 ? 2.5 : 0);
  }
  // Ground gained, and a sight of goal for the attackers.
  s += tac.w.prog * (c.y - h.y) * 0.3;
  if (!job.rest) s += tac.w.goal * Math.max(0, 1 - Math.hypot(c.x, HALF_L - c.y) / 20);
  // Room from teammates: nobody stands on top of anyone.
  for (const t of w.taken) {
    const d = Math.hypot(t.x - c.x, t.y - c.y);
    if (d < tac.space) s -= (tac.space - d) ** 2 * 0.15;
  }
  // Close enough to be an option, not so close the carrier's marker picks off both.
  const dc = Math.hypot(c.x - h.x, c.y - h.y);
  if (dc < job.near) s -= (job.near - dc) * 0.5;
  if (dc > tac.far) s -= (dc - tac.far) * 0.4;
  // Not hugging the touchline or the goal line.
  const ex = Math.abs(c.x) - (HALF_W - 5);
  if (ex > 0) s -= ex * 0.5;
  const ey = c.y - (HALF_L - 6);
  if (ey > 0) s -= ey * 0.6;
  // A little loyalty to the current spot, so nobody dithers between two equal ones.
  if (Math.hypot(c.x - prev.x, c.y - prev.y) < 1.2) s += 0.5;
  return s;
}

function bestSpot(w: SpotWorld, job: Job, anchor: Pt, prev: Pt): Pt {
  const yMax = job.rest ? anchor.y + 1.5 : Math.min(job.top, w.line + 0.5);
  const cands: Pt[] = [anchor, prev];
  for (const r of [job.roam * 0.5, job.roam]) for (const u of RING) cands.push({ x: anchor.x + u.x * r, y: anchor.y + u.y * r });
  let best = anchor;
  let bestS = -Infinity;
  for (const c0 of cands) {
    const c = { x: clamp(c0.x, -(HALF_W - 2.5), HALF_W - 2.5), y: clamp(c0.y, -HALF_L + 4, Math.max(-HALF_L + 4, yMax)) };
    const s = spotScore(w, job, anchor, prev, c);
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  return best;
}

function planAttack(sim: MatchSim, team: Team, plan: TeamPlan): void {
  const tac = TACTICS[sim.tactic[team]];
  const P = sim.players;
  const b = sim.ball;
  const base = team * PLAYERS_PER_TEAM;
  // Play revolves around the man on the ball, or the receiver of our pass on its way.
  const hub = b.owner >= 0 ? b.owner : b.passTarget;
  const hp = hub >= 0 ? P[hub] : null;
  const h = hp ? toTeam(team, hp.x + hp.vx * 0.3, hp.y + hp.vy * 0.3) : toTeam(team, b.x, b.y);
  const opps: Pt[] = [];
  let keeper: Pt = { x: 0, y: HALF_L };
  for (const q of P) {
    if (q.team === team) continue;
    const o = toTeam(team, q.x + q.vx * 0.4, q.y + q.vy * 0.4);
    if (q.role === 0) keeper = o;
    else opps.push(o);
  }
  // The line to beat (the ball, once it is past them all).
  const line = Math.min(Math.max(lastLine(sim, team), h.y), HALF_L - 5);
  // A run is only worth making when the man on the ball can play it: facing forward, and for the
  // computer nobody on top of him (a human can thread it under pressure).
  let free = false;
  if (hp && b.owner === hub) {
    const face = toTeam(team, hp.fx, hp.fy);
    let pressure = 99;
    for (const o of opps) pressure = Math.min(pressure, Math.hypot(o.x - h.x, o.y - h.y));
    free = face.y > -0.3 && (hp.human >= 0 || pressure > 1.8);
  }
  // Where the team's middle is: the ball, less how far up or back the man on it normally plays.
  const hubAhead = !hp ? 0 : hp.role === 0 ? -16 : (tac.jobs[hp.role]?.ahead ?? 0);
  const c = h.y - 0.5 * hubAhead;
  const w: SpotWorld = { tac, h, hasHub: hp !== null, line, opps, keeper, taken: hp ? [h] : [] };
  let running = 0;
  for (let r = 1; r < PLAYERS_PER_TEAM; r++) {
    const q = P[base + r];
    if (base + r !== hub && q.human >= 0) w.taken.push(toTeam(team, q.x, q.y));
    if (sim.brain[base + r].run > 0) running++;
  }
  for (const role of ATTACK_ORDER) {
    const i = base + role;
    const q = P[i];
    if (i === hub || q.human >= 0) {
      plan.spot[role] = { x: q.x, y: q.y };
      continue;
    }
    const job = tac.jobs[role]!;
    const br = sim.brain[i];
    const me = toTeam(team, q.x, q.y);
    const anchor = anchorFor(role, job, h, c, line, opps);
    const room = line < HALF_L - 8 && me.y > line - 9;
    if (br.run <= 0 && br.cd <= 0 && job.runs > 0 && free && room && running < tac.runners && sim.rng.chance(job.runs * 0.3)) {
      // Off he goes: a sprint in behind, timed so the pass can be played into his stride.
      const to = runTarget(job, anchor, line, opps);
      br.rx = to.x;
      br.ry = to.y;
      br.run = Math.min(2.2, Math.hypot(to.x - me.x, to.y - me.y) / SPRINT + 0.4);
      br.cd = br.run + 2.5 + sim.rng.next() * 2;
      running++;
    }
    let spot: Pt;
    let speed: number;
    if (br.run > 0) {
      spot = { x: br.rx, y: br.ry };
      speed = SPRINT;
    } else {
      spot = bestSpot(w, job, anchor, toTeam(team, plan.spot[role].x, plan.spot[role].y));
      // Far out of position (the ball has just been won): get there quickly. Otherwise move like a footballer.
      speed = Math.hypot(spot.x - me.x, spot.y - me.y) > 8 ? SPRINT * 0.92 : WALK;
    }
    w.taken.push(spot);
    plan.spot[role] = toTeam(team, spot.x, spot.y);
    plan.speed[role] = speed;
  }
}

// --- off the ball: defence --------------------------------------------------------------------

/** Defensive block by role: lane across, depth relative to the ball, and how deep / high it may go. */
const SHAPE = [
  { x: 0, ahead: 0, lo: 0, hi: 0 },
  { x: -7, ahead: -7, lo: -HALF_L + 4, hi: -1 },
  { x: 7, ahead: -7, lo: -HALF_L + 4, hi: -1 },
  { x: -11, ahead: -1.5, lo: -HALF_L + 9, hi: 9 },
  { x: 11, ahead: -1.5, lo: -HALF_L + 9, hi: 9 },
  // The striker stays up for the counter-attack and screens passes back.
  { x: 0, ahead: 5, lo: -8, hi: 18 },
  { x: 0, ahead: -3.5, lo: -HALF_L + 7, hi: 5 },
];

function planDefence(sim: MatchSim, team: Team, plan: TeamPlan): void {
  const P = sim.players;
  const b = sim.ball;
  const base = team * PLAYERS_PER_TEAM;
  const carrier = b.owner >= 0 && P[b.owner].team !== team ? b.owner : -1;
  const ref = carrier >= 0 ? P[carrier] : b.passTarget >= 0 ? P[b.passTarget] : null;
  const bt = ref ? toTeam(team, ref.x, ref.y) : toTeam(team, b.x, b.y);
  const diff = sim.teamHasHuman(team) ? 1 : sim.cfg.difficulty;
  // Home spots: a compact block that slides across and up and down with the ball.
  const home: Pt[] = [];
  for (let r = 1; r < PLAYERS_PER_TEAM; r++) {
    const s = SHAPE[r];
    let y = clamp(bt.y + s.ahead, s.lo, s.hi);
    if (r <= 2) y = Math.min(y, bt.y - 2);
    home[r] = { x: clamp(s.x * 0.85 + bt.x * 0.4, -(HALF_W - 3), HALF_W - 3), y };
  }
  // The nearest presses and the next covers (see aiThink): they don't mark. Nor does the striker.
  const presser = carrier >= 0 ? closestOutfield(sim, team, P[carrier].x, P[carrier].y) : -1;
  const cover = presser >= 0 ? closestOutfield(sim, team, P[carrier].x, P[carrier].y, presser) : -1;
  const free: number[] = [];
  for (const r of [1, 2, 6, 3, 4]) if (base + r !== presser && base + r !== cover && P[base + r].human < 0) free.push(r);
  // Their players without the ball, where they are heading, most dangerous (nearest our goal) first.
  const runners: Pt[] = [];
  for (const q of P) {
    if (q.team === team || q.role === 0 || P.indexOf(q) === carrier) continue;
    const a = toTeam(team, q.x + q.vx * 0.3, q.y + q.vy * 0.3);
    // One of ours (a human) already on him.
    if (P.some((m) => m.team === team && m.human >= 0 && Math.hypot(m.x - q.x, m.y - q.y) < 3)) continue;
    if (a.y < 14) runners.push(a);
  }
  runners.sort((a, c) => a.y + Math.abs(a.x) * 0.3 - (c.y + Math.abs(c.x) * 0.3));
  // How tight the marking is (m): harder computer teams stay closer.
  const markD = [3.4, 2.7, 2.1][diff] ?? 2.7;
  const spot: (Pt | undefined)[] = [];
  for (const a of runners) {
    let bestR = -1;
    // A runner in the zone; one left behind the block is picked up by the nearest, wherever he is.
    let bestD = a.y < bt.y - 8 ? 30 : 12;
    for (const r of free) {
      const d = Math.hypot(home[r].x - a.x, home[r].y - a.y);
      if (d < bestD) {
        bestD = d;
        bestR = r;
      }
    }
    if (bestR < 0) continue;
    free.splice(free.indexOf(bestR), 1);
    // Goal-side and a little ball-side of him: between the runner and our goal, leaning towards the pass.
    const gl = Math.hypot(a.x, -HALF_L - a.y) || 1;
    const bl = Math.hypot(bt.x - a.x, bt.y - a.y) || 1;
    const ux = (-a.x / gl) * 0.75 + ((bt.x - a.x) / bl) * 0.25;
    const uy = ((-HALF_L - a.y) / gl) * 0.75 + ((bt.y - a.y) / bl) * 0.25;
    const ul = Math.hypot(ux, uy) || 1;
    spot[bestR] = { x: a.x + (ux / ul) * markD, y: a.y + (uy / ul) * markD };
  }
  for (let r = 1; r < PLAYERS_PER_TEAM; r++) {
    const q = P[base + r];
    const s = spot[r] ?? home[r];
    plan.spot[r] = toTeam(team, s.x, s.y);
    plan.speed[r] = Math.hypot(plan.spot[r].x - q.x, plan.spot[r].y - q.y) > 5 ? SPRINT * 0.9 : WALK;
  }
}

/** The team's plan, re-made when it is stale or possession changes. Harder computer teams react sooner. */
function planFor(sim: MatchSim, team: Team): TeamPlan {
  const plan = sim.plans[team];
  const poss = sim.possession();
  const attacking = poss === -1 ? plan.attacking : poss === team;
  const every = attacking ? 12 : sim.teamHasHuman(team) ? 9 : ([15, 10, 7][sim.cfg.difficulty] ?? 10);
  if (sim.tick - plan.tick < every && attacking === plan.attacking) return plan;
  const dt = Math.min(1, (sim.tick - plan.tick) * DT);
  plan.tick = sim.tick;
  for (let r = 1; r < PLAYERS_PER_TEAM; r++) {
    const br = sim.brain[team * PLAYERS_PER_TEAM + r];
    br.run = attacking === plan.attacking ? Math.max(0, br.run - dt) : 0;
    br.cd = Math.max(0, br.cd - dt);
  }
  plan.attacking = attacking;
  if (attacking) planAttack(sim, team, plan);
  else planDefence(sim, team, plan);
  return plan;
}

// --- per player -------------------------------------------------------------------------------

export function aiThink(sim: MatchSim, i: number, formationOnly: boolean): AiMove {
  const p = sim.players[i];
  const b = sim.ball;
  const team = p.team;
  const opp = (1 - team) as Team;
  const diff = sim.cfg.difficulty;
  const bt = toTeam(team, b.x, b.y);

  // --- Goalkeeper ---
  if (p.role === 0) {
    if (b.owner === i) return { vx: 0, vy: 0 };
    const goalY = -HALF_L + 1.0;
    let tx = Math.max(-2.4, Math.min(2.4, bt.x * 0.22));
    let ty = goalY + Math.max(0, Math.min(3, (bt.y + 12) * -0.1 + 1.2));
    // Rush out for a loose ball in the box.
    if (!formationOnly && b.owner < 0 && bt.y < -HALF_L + 8 && Math.abs(bt.x) < 9 && Math.hypot(b.vx, b.vy) < 9) {
      tx = bt.x;
      ty = bt.y;
    }
    const w = toTeam(team, tx, ty);
    return seek(p.x, p.y, w.x, w.y, SPRINT);
  }

  if (formationOnly || sim.state !== 'play') return formationMove(sim, i);

  // --- Ball carrier ---
  if (b.owner === i) return carrierThink(sim, i);

  const ourPass = b.passTarget >= 0 && sim.players[b.passTarget].team === team;
  if (b.owner < 0 && b.passTarget !== i && !ourPass) {
    // Loose ball (or their pass): the closest computer player of each team goes for it (a long ball: where it comes down).
    const lead = 0.35;
    const spot = b.flying ? sim.receivePoint() : { x: b.x + b.vx * lead, y: b.y + b.vy * lead };
    if (closestOutfield(sim, team, spot.x, spot.y) === i) return seek(p.x, p.y, spot.x, spot.y, SPRINT);
  } else if (b.passTarget === i) {
    const run = sim.passRun;
    if (!b.flying && Math.hypot(run.x, run.y) > 1.5) {
      // A ground pass is aimed into the run: keep going and it arrives at your feet.
      return { vx: run.x, vy: run.y };
    }
    // Standing still: step in to meet it (run to where a long ball comes down).
    const r = sim.receivePoint();
    return seek(p.x, p.y, r.x, r.y, b.z > 0.05 ? SPRINT : WALK);
  } else if (b.owner >= 0 && sim.players[b.owner].team === opp) {
    // Opponent has the ball: nearest presses, second nearest covers.
    const o = sim.players[b.owner];
    const presser = closestOutfield(sim, team, o.x, o.y);
    const gy = team === 0 ? -HALF_L : HALF_L;
    if (presser === i) {
      // Approach from the goal side.
      const dx = 0 - o.x;
      const dy = gy - o.y;
      const dl = Math.hypot(dx, dy) || 1;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      // Close down fast, then jockey: gives the carrier a moment to pass. A human running off is chased
      // a little faster than they go, so they can't simply outrun the presser.
      const chase = o.human >= 0 ? Math.min(SPRINT, Math.hypot(o.vx, o.vy) + 0.8) : 0;
      const speed = d > 2.5 ? SPRINT : Math.max(WALK * [0.8, 0.9, 1.0][diff], chase);
      return seek(p.x, p.y, o.x + (dx / dl) * 0.5, o.y + (dy / dl) * 0.5, speed);
    }
    if (closestOutfield(sim, team, o.x, o.y, presser) === i) {
      return seek(p.x, p.y, o.x * 0.6, o.y + (gy - o.y) * 0.3, WALK);
    }
  }
  const plan = planFor(sim, team);
  const s = plan.spot[p.role];
  return seek(p.x, p.y, s.x, s.y, plan.speed[p.role], 2.5);
}

/** Before the whistle and after a goal: the formation, shifted with the ball. */
function formationMove(sim: MatchSim, i: number): AiMove {
  const p = sim.players[i];
  const team = p.team;
  const bt = toTeam(team, sim.ball.x, sim.ball.y);
  const attacking = sim.possession() === team;
  const f = FORMATION[p.role];
  let tx = f.x * 0.85 + bt.x * 0.35;
  let ty = f.y + bt.y * 0.5 + (attacking ? 7 : -1);
  if (p.role <= 2 && !attacking) ty = Math.min(ty, bt.y - 3);
  ty = Math.max(-HALF_L + 3, Math.min(HALF_L - 3, ty));
  const w = toTeam(team, tx, ty);
  return seek(p.x, p.y, w.x, w.y, WALK * 0.85);
}

function carrierThink(sim: MatchSim, i: number): AiMove {
  const p = sim.players[i];
  const team = p.team;
  const tac = TACTICS[sim.tactic[team]];
  const pt = toTeam(team, p.x, p.y);
  const area = shotArea(team, p.x, p.y);
  const near = nearestOpponent(sim, i);
  sim.aiTimer[i] -= 1 / 60;
  // Every few tenths of a second, or at once when a tackle is coming in.
  const decide = sim.aiTimer[i] <= 0 || near.d < 1.9;

  if (decide) {
    sim.aiTimer[i] = 0.25 + sim.rng.next() * 0.2;
    const keeper = sim.players[sim.keeperOf((1 - team) as Team)];
    const kx = toTeam(team, keeper.x, keeper.y).x;
    const pickCol = (): -1 | 0 | 1 => {
      const away = kx > 0.4 ? -1 : kx < -0.4 ? 1 : sim.rng.chance(0.5) ? -1 : 1;
      // Columns are in pitch coordinates; team 1 attacks the other way.
      return (team === 0 ? away : -away) as -1 | 0 | 1;
    };
    if (area === 'impossible' || area === 'danger') {
      sim.shoot(i, pickCol(), sim.rng.chance(0.5), 0.55 + sim.rng.next() * 0.45);
      return { vx: 0, vy: 0 };
    }
    const pass = bestPass(sim, i);
    // From the edge of the box with a clear sight of goal (nobody in the way), have a go.
    let sight = 9;
    const gy = toTeam(team, 0, HALF_L).y;
    for (const e of sim.players) if (e.team !== team && e.role !== 0) sight = Math.min(sight, laneGap(p.x, p.y, 0, gy, e.x, e.y));
    const range = area === 'long' && pt.y > HALF_L - 16 && Math.abs(pt.x) < 10 && near.d > 2.2;
    if (range && sim.rng.chance(sight > 1.6 ? 0.35 : 0.06)) {
      sim.shoot(i, pickCol(), sim.rng.chance(0.4), 0.7 + sim.rng.next() * 0.3);
      return { vx: 0, vy: 0 };
    }
    const pressured = near.d < 2.6;
    if (pass.j >= 0 && ((pressured && pass.score > -2) || pass.score > tac.passEager + sim.rng.next() * 3)) {
      sim.pass(i, 0, 0, pass.j, pass.lofted);
      return { vx: 0, vy: 0 };
    }
  }

  // Dribble towards goal, drifting away from the nearest opponent.
  const goal = toTeam(team, 0, HALF_L - 4);
  let dx = goal.x - p.x;
  let dy = goal.y - p.y;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl;
  dy /= dl;
  if (near.j >= 0 && near.d < 5) {
    const o = sim.players[near.j];
    const ax = p.x - o.x;
    const ay = p.y - o.y;
    const al = Math.hypot(ax, ay) || 1;
    dx += (ax / al) * 0.6;
    dy += (ay / al) * 0.6;
  }
  // Away from the touchlines: no dribbling into the corner flag.
  dx -= Math.sign(p.x) * Math.max(0, Math.abs(p.x) - (HALF_W - 5)) * 0.3;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return { vx: dx * WALK * 0.92, vy: dy * WALK * 0.92 };
}
