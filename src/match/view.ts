// What a screen needs to draw a match. Built straight from the simulation (local/host),
// or decoded from network snapshots and interpolated (clients).

import type { MatchSim } from './sim';
import type { MatchEvent, MatchState, ShotArea, Team } from './types';

export interface PlayerView {
  x: number;
  y: number;
  fx: number;
  fy: number;
  team: Team;
  role: number;
  /** Human slot controlling this player, -1 = computer. */
  human: number;
  sprinting: boolean;
}

export interface DuelView {
  team: Team;
  area: ShotArea;
  tx: number;
  ty: number;
  tick: number;
  /** -2 undecided, -1 stayed, 0..5 zone. */
  dive: number;
  keeperHuman: boolean;
  outcome: 'goal' | 'saved' | null;
}

export interface ViewState {
  tick: number;
  clock: number;
  state: MatchState;
  score: [number, number];
  kickoffTeam: Team;
  ball: { x: number; y: number; z: number; owner: number };
  players: PlayerView[];
  duel: DuelView | null;
}

export function viewFromSim(sim: MatchSim): ViewState {
  const d = sim.duel;
  return {
    tick: sim.tick,
    clock: sim.clock,
    state: sim.state,
    score: [sim.score[0], sim.score[1]],
    kickoffTeam: sim.kickoffTeam,
    ball: { x: sim.ball.x, y: sim.ball.y, z: sim.ball.z, owner: sim.ball.owner },
    players: sim.players.map((p) => ({
      x: p.x,
      y: p.y,
      fx: p.fx,
      fy: p.fy,
      team: p.team,
      role: p.role,
      human: p.human,
      sprinting: p.sprinting,
    })),
    duel:
      d && (sim.state === 'duel' || sim.state === 'goal')
        ? {
            team: d.team,
            area: d.area,
            tx: d.tx,
            ty: d.ty,
            tick: d.tick,
            dive: d.dive === undefined ? -2 : d.dive === null ? -1 : d.dive.row * 3 + d.dive.col + 1,
            keeperHuman: d.keeperHuman,
            outcome: d.outcome,
          }
        : null,
  };
}

// --- binary snapshot encoding -----------------------------------------------------------------

const STATES: MatchState[] = ['kickoff', 'play', 'duel', 'goal', 'ended'];
const AREAS: ShotArea[] = ['own', 'long', 'danger', 'impossible'];
const OUTCOMES = [null, 'goal', 'saved'] as const;
const HEADER = 20;
const PER_PLAYER = 6;

const EVENT_TYPES: MatchEvent['type'][] = ['kick', 'pass', 'steal', 'shot', 'goal', 'save', 'whistle', 'bounce'];

function encodeEvent(e: MatchEvent): [number, number, number] {
  const t = EVENT_TYPES.indexOf(e.type);
  switch (e.type) {
    case 'kick':
      return [t, e.power, 0];
    case 'pass':
      return [t, e.from, e.to];
    case 'steal':
    case 'save':
      return [t, e.by, 0];
    case 'shot':
      return [t, e.by, AREAS.indexOf(e.area)];
    case 'goal':
      return [t, e.team, e.by];
    case 'whistle':
      return [t, e.long ? 1 : 0, 0];
    default:
      return [t, 0, 0];
  }
}

function decodeEvent(t: number, a: number, b: number, v: ViewState): MatchEvent {
  switch (EVENT_TYPES[t]) {
    case 'kick':
      return { type: 'kick', x: v.ball.x, y: v.ball.y, power: a };
    case 'pass':
      return { type: 'pass', from: a, to: b };
    case 'steal':
      return { type: 'steal', by: a };
    case 'save':
      return { type: 'save', by: a };
    case 'shot':
      return { type: 'shot', by: a, area: AREAS[b] };
    case 'goal':
      return { type: 'goal', team: a as Team, by: b };
    case 'whistle':
      return { type: 'whistle', long: a === 1 };
    default:
      return { type: 'bounce' };
  }
}

export function encodeSnapshot(v: ViewState, events: readonly MatchEvent[]): Float32Array {
  const n = v.players.length;
  const out = new Float32Array(HEADER + n * PER_PLAYER + 1 + events.length * 3);
  const d = v.duel;
  out.set([
    v.tick,
    v.clock,
    STATES.indexOf(v.state),
    v.score[0],
    v.score[1],
    v.kickoffTeam,
    v.ball.x,
    v.ball.y,
    v.ball.z,
    v.ball.owner,
    d ? 1 : 0,
    d?.team ?? 0,
    d ? AREAS.indexOf(d.area) : 0,
    d?.tx ?? 0,
    d?.ty ?? 0,
    d?.tick ?? 0,
    d?.dive ?? -2,
    d ? (d.keeperHuman ? 1 : 0) : 0,
    d ? OUTCOMES.indexOf(d.outcome) : 0,
    n,
  ]);
  let o = HEADER;
  for (const p of v.players) {
    out.set([p.x, p.y, p.fx, p.fy, p.team * 8 + p.role, (p.human + 1) * 2 + (p.sprinting ? 1 : 0)], o);
    o += PER_PLAYER;
  }
  out[o++] = events.length;
  for (const e of events) {
    out.set(encodeEvent(e), o);
    o += 3;
  }
  return out;
}

export function decodeSnapshot(f: Float32Array): { view: ViewState; events: MatchEvent[] } {
  const n = f[19];
  const hasDuel = f[10] === 1;
  const view: ViewState = {
    tick: f[0],
    clock: f[1],
    state: STATES[f[2]],
    score: [f[3], f[4]],
    kickoffTeam: f[5] as Team,
    ball: { x: f[6], y: f[7], z: f[8], owner: f[9] },
    duel: hasDuel
      ? {
          team: f[11] as Team,
          area: AREAS[f[12]],
          tx: f[13],
          ty: f[14],
          tick: f[15],
          dive: f[16],
          keeperHuman: f[17] === 1,
          outcome: OUTCOMES[f[18]],
        }
      : null,
    players: [],
  };
  let o = HEADER;
  for (let i = 0; i < n; i++) {
    const tr = f[o + 4];
    const hs = f[o + 5];
    view.players.push({
      x: f[o],
      y: f[o + 1],
      fx: f[o + 2],
      fy: f[o + 3],
      team: Math.floor(tr / 8) as Team,
      role: tr % 8,
      human: Math.floor(hs / 2) - 1,
      sprinting: hs % 2 === 1,
    });
    o += PER_PLAYER;
  }
  const ne = f[o++];
  const events: MatchEvent[] = [];
  for (let i = 0; i < ne; i++, o += 3) events.push(decodeEvent(f[o], f[o + 1], f[o + 2], view));
  return { view, events };
}

/** Linear blend between two snapshots (positions only; everything else from the newer one). */
export function interpolate(a: ViewState, b: ViewState, k: number): ViewState {
  const lerp = (x: number, y: number) => x + (y - x) * k;
  // Don't smear teleports (kickoff resets).
  const jump = Math.hypot(a.ball.x - b.ball.x, a.ball.y - b.ball.y) > 8;
  if (jump || a.players.length !== b.players.length) return b;
  return {
    ...b,
    ball: { ...b.ball, x: lerp(a.ball.x, b.ball.x), y: lerp(a.ball.y, b.ball.y), z: lerp(a.ball.z, b.ball.z) },
    players: b.players.map((p, i) => ({ ...p, x: lerp(a.players[i].x, p.x), y: lerp(a.players[i].y, p.y) })),
  };
}
