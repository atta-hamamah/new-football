// Decides what happens to a single penalty: shot point + keeper dive -> outcome.
// Shared by Penalty Run and by every shot in a 6v6 match.

import { BALL_R, dist, GOAL_H, GOAL_HALF_W, PENALTY_DIST, type Point } from './goal';

export type Outcome = 'goal' | 'saved' | 'post' | 'wide' | 'over';

export interface Shot extends Point {
  /** Ball speed in m/s. Faster shots give the keeper less time. */
  speed: number;
}

export interface Dive {
  /** Where the keeper commits his body (usually a zone centre). */
  target: Point;
  /** How far he can stretch from there, in metres. */
  reach: number;
  /** 0..1: how much he can still correct towards the ball after committing. */
  adjust: number;
}

export interface ResolveOptions {
  /** Shots that clip the frame go in instead of bouncing out. */
  postIn?: boolean;
  /** Metres of keeper reach removed for shots placed into a corner. */
  cornerBonus?: number;
}

export interface Resolution {
  outcome: Outcome;
  /** Where the keeper ended up (for animation). */
  keeper: Point;
  /** Time the ball takes to reach the goal, seconds. */
  flightTime: number;
  /** Distance between keeper and ball at the line (negative = inside his reach). */
  margin: number;
}

export const REFERENCE_FLIGHT = 0.42;

export function flightTime(speed: number): number {
  return PENALTY_DIST / Math.max(5, speed);
}

export function isCorner(p: Point): boolean {
  return Math.abs(p.x) > GOAL_HALF_W * 0.68 && (p.y > GOAL_H * 0.62 || p.y < 0.45);
}

export function resolveShot(shot: Shot, dive: Dive, opts: ResolveOptions = {}): Resolution {
  const t = flightTime(shot.speed);
  const ax = Math.abs(shot.x);
  const keeperStart = dive.target;

  if (ax > GOAL_HALF_W + BALL_R) return { outcome: 'wide', keeper: keeperStart, flightTime: t, margin: 99 };
  if (shot.y > GOAL_H + BALL_R) return { outcome: 'over', keeper: keeperStart, flightTime: t, margin: 99 };
  const hitsFrame = ax > GOAL_HALF_W - BALL_R || shot.y > GOAL_H - BALL_R;
  if (hitsFrame && !opts.postIn) return { outcome: 'post', keeper: keeperStart, flightTime: t, margin: 99 };

  const keeper = {
    x: dive.target.x + (shot.x - dive.target.x) * dive.adjust,
    y: dive.target.y + (shot.y - dive.target.y) * dive.adjust,
  };
  let reach = dive.reach + (t - REFERENCE_FLIGHT) * 2.2;
  if (isCorner(shot)) reach -= opts.cornerBonus ?? 0;
  const margin = dist(shot, keeper) - reach;
  // A shot off the frame that "comes in off the post" is unstoppable.
  const saved = !hitsFrame && margin <= 0;
  return { outcome: saved ? 'saved' : 'goal', keeper, flightTime: t, margin };
}
