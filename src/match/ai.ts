// Computer players: keep the team shape, press the ball, offer passing options,
// and make decisions on the ball (dribble, pass to the open man, shoot in range).

import type { MatchSim } from './sim';
import { FORMATION, SPRINT, toTeam, WALK } from './sim';
import { HALF_L, PLAYERS_PER_TEAM, shotArea, type Team } from './types';

export interface AiMove {
  vx: number;
  vy: number;
}

function seek(px: number, py: number, tx: number, ty: number, maxSpeed: number, slowRadius = 3): AiMove {
  const dx = tx - px;
  const dy = ty - py;
  const d = Math.hypot(dx, dy);
  if (d < 0.15) return { vx: 0, vy: 0 };
  const speed = d < slowRadius ? (maxSpeed * d) / slowRadius : maxSpeed;
  return { vx: (dx / d) * speed, vy: (dy / d) * speed };
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

/** Scores pass options: open, forward, and not through an opponent. */
export function bestPass(sim: MatchSim, i: number): { j: number; score: number } {
  const p = sim.players[i];
  const pt = toTeam(p.team, p.x, p.y);
  let best = { j: -1, score: -Infinity };
  for (let j = p.team * PLAYERS_PER_TEAM + 1; j < (p.team + 1) * PLAYERS_PER_TEAM; j++) {
    if (j === i) continue;
    const q = sim.players[j];
    const qt = toTeam(q.team, q.x, q.y);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    let open = 10;
    let lane = 10;
    for (const e of sim.players) {
      if (e.team === p.team) continue;
      open = Math.min(open, Math.hypot(e.x - q.x, e.y - q.y));
      // Distance from the opponent to the pass line (ignoring whoever is marking the passer:
      // the ball is already past him when it leaves the foot).
      if (Math.hypot(e.x - p.x, e.y - p.y) < 1.8) continue;
      const t = ((e.x - p.x) * (q.x - p.x) + (e.y - p.y) * (q.y - p.y)) / (d * d || 1);
      if (t < 0.08 || t > 1) continue;
      lane = Math.min(lane, Math.hypot(p.x + (q.x - p.x) * t - e.x, p.y + (q.y - p.y) * t - e.y));
    }
    const score = Math.min(open, 7) * 0.7 + (qt.y - pt.y) * 0.22 - (lane < 1.4 ? 8 : 0) - Math.max(0, d - 22) * 0.4 - (d < 4 ? 2 : 0);
    if (score > best.score) best = { j, score };
  }
  return best;
}

export function aiThink(sim: MatchSim, i: number, formationOnly: boolean): AiMove {
  const p = sim.players[i];
  const b = sim.ball;
  const team = p.team;
  const opp = (1 - team) as Team;
  const diff = sim.cfg.difficulty;
  const bt = toTeam(team, b.x, b.y);
  const poss = sim.possession();
  const attacking = poss === team;

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

  // --- Ball carrier ---
  if (b.owner === i && !formationOnly && sim.state === 'play') {
    return carrierThink(sim, i);
  }

  // --- Formation target ---
  const f = FORMATION[p.role];
  let tx = f.x * 0.85 + bt.x * 0.35;
  let ty = f.y + bt.y * 0.5 + (attacking ? 7 : -1);
  if (attacking) {
    // Spread wide and make forward runs.
    tx = f.x * 1.15 + bt.x * 0.2;
    if (p.role === 5) ty = Math.min(bt.y + 11, HALF_L - 5);
    if (p.role === 3 || p.role === 4) ty = Math.min(bt.y + 5, HALF_L - 8);
  } else if (p.role <= 2) {
    // Defenders stay goal-side of the ball.
    ty = Math.min(ty, bt.y - 3);
  }
  ty = Math.max(-HALF_L + 3, Math.min(HALF_L - 3, ty));
  let target = toTeam(team, tx, ty);
  let speed = WALK * 0.85;

  if (!formationOnly && sim.state === 'play') {
    if (b.owner < 0 && b.passTarget !== i) {
      // Loose ball: the closest computer player of each team goes for it.
      const lead = 0.35;
      const px = b.x + b.vx * lead;
      const py = b.y + b.vy * lead;
      if (closestOutfield(sim, team, px, py) === i) {
        target = { x: px, y: py };
        speed = SPRINT;
      }
    } else if (b.passTarget === i) {
      // Move to meet the pass.
      target = { x: b.x + b.vx * 0.25, y: b.y + b.vy * 0.25 };
      speed = WALK;
    } else if (b.owner >= 0 && sim.players[b.owner].team === opp) {
      // Opponent has the ball: nearest presses, second nearest covers.
      const o = sim.players[b.owner];
      const presser = closestOutfield(sim, team, o.x, o.y);
      if (presser === i) {
        const gy = team === 0 ? -HALF_L : HALF_L;
        // Approach from the goal side.
        const dx = 0 - o.x;
        const dy = gy - o.y;
        const dl = Math.hypot(dx, dy) || 1;
        target = { x: o.x + (dx / dl) * 0.5, y: o.y + (dy / dl) * 0.5 };
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        // Close down fast, then jockey: gives the carrier a moment to pass.
        speed = d > 2.5 ? SPRINT : WALK * [0.8, 0.9, 1.0][diff];
      } else if (closestOutfield(sim, team, o.x, o.y, presser) === i) {
        const gy = team === 0 ? -HALF_L : HALF_L;
        target = { x: o.x * 0.6, y: o.y + (gy - o.y) * 0.3 };
        speed = WALK;
      }
    }
  }
  return seek(p.x, p.y, target.x, target.y, speed);
}

function carrierThink(sim: MatchSim, i: number): AiMove {
  const p = sim.players[i];
  const team = p.team;
  const pt = toTeam(team, p.x, p.y);
  const area = shotArea(team, p.x, p.y);
  const near = nearestOpponent(sim, i);
  sim.aiTimer[i] -= 1 / 60;
  const decide = sim.aiTimer[i] <= 0 || near.d < 2.2;

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
    if (area === 'long' && pt.y > HALF_L - 16 && Math.abs(pt.x) < 10 && near.d > 3 && sim.rng.chance(0.08)) {
      sim.shoot(i, pickCol(), sim.rng.chance(0.4), 0.7 + sim.rng.next() * 0.3);
      return { vx: 0, vy: 0 };
    }
    const pressured = near.d < 2.6;
    if (pass.j >= 0 && ((pressured && pass.score > -2) || pass.score > 4.5 + sim.rng.next() * 3)) {
      sim.pass(i, 0, 0, pass.j);
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
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
  }
  return { vx: dx * WALK * 0.92, vy: dy * WALK * 0.92 };
}
