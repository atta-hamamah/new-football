// Attacking tactics: how the players without the ball move while their team has it.
// Every outfield player has a fixed role (shirt number) and each tactic gives that role a job:
// where it lives relative to the ball, how far it looks around for open space, how close it
// comes to the man on the ball and how keen it is to run in behind for a through ball.
// Team coordinates throughout: the team attacks +y, x < 0 is its left.

import { HALF_L } from './types';

export type Tactic = 'balanced' | 'possession' | 'direct';
export const TACTIC_IDS: readonly Tactic[] = ['balanced', 'possession', 'direct'];

/** Shirt numbers by role: 1 keeper, 2 and 3 defenders, 4 central midfielder, 5 and 6 wingers, 7 striker. */
export const SHIRT = [1, 2, 3, 5, 6, 7, 4] as const;
/** What each role is called, by role. */
export const ROLE_NAME = ['Keeper', 'Left back', 'Right back', 'Left wing', 'Right wing', 'Striker', 'Midfielder'] as const;

export interface Job {
  /** Lane across the pitch (m). */
  x: number;
  /** How far the lane slides towards the ball (0 = keeps its lane, 1 = follows the ball). */
  follow: number;
  /** Preferred depth relative to the ball (m, + = nearer the goal we attack), and its limits. */
  ahead: number;
  min: number;
  max: number;
  /** Highest point up the pitch the role goes to (team y). */
  top: number;
  /** How far (m) it looks around its spot for open space. */
  roam: number;
  /** Closest it comes to the man on the ball (m), so it never crowds him. */
  near: number;
  /** 0..1: how keen it is to run in behind the defence. */
  runs: number;
  /** Stays behind the ball against the counter-attack. */
  rest?: boolean;
  /** A defender on the ball's side pushes up this much further (m). */
  overlap?: number;
}

export interface TacticDef {
  id: Tactic;
  name: string;
  blurb: string;
  /** By role; the keeper (0) has no job. */
  jobs: readonly (Job | null)[];
  /** Teammates closer than this push each other apart (m): the pitch never feels crowded. */
  space: number;
  /** Farthest it is worth being from the man on the ball (m). */
  far: number;
  /** What a good spot is worth: space around it, a clear passing lane, ground gained, a sight of goal. */
  w: { open: number; lane: number; prog: number; goal: number };
  /** At most this many players run in behind at once. */
  runners: number;
  /** On the ball (computer): how good a pass must be before it is played (lower = sooner). */
  passEager: number;
  /** How much a pass is worth per metre it gains. */
  passForward: number;
  /** Extra worth of a through ball to a player running in behind. */
  through: number;
  /** Whether long balls over the defence are played. */
  loft: boolean;
}

/** Mirrors a left-side job for the right side. */
const mirror = (j: Job): Job => ({ ...j, x: -j.x });

function jobs(back: Job, wing: Job, striker: Job, mid: Job): (Job | null)[] {
  return [null, back, mirror(back), wing, mirror(wing), striker, mid];
}

export const TACTICS: Record<Tactic, TacticDef> = {
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    blurb: '5 and 6 keep the width, the 4 supports, the 7 picks the moment to run in behind.',
    jobs: jobs(
      { x: -10, follow: 0.3, ahead: -9, min: -16, max: -4, top: 8, roam: 4, near: 7, runs: 0, rest: true, overlap: 5 },
      { x: -14, follow: 0.25, ahead: 6, min: -1, max: 15, top: HALF_L - 8, roam: 6, near: 8, runs: 0.55 },
      { x: 0, follow: 0.35, ahead: 11, min: 4, max: 20, top: HALF_L - 6, roam: 6, near: 9, runs: 0.8 },
      { x: 0, follow: 0.35, ahead: -5, min: -10, max: 2, top: 16, roam: 6, near: 6, runs: 0.1 },
    ),
    space: 8,
    far: 24,
    w: { open: 0.8, lane: 0.6, prog: 0.5, goal: 1.5 },
    runners: 1,
    passEager: 4.5,
    passForward: 0.22,
    through: 1.5,
    loft: false,
  },
  possession: {
    id: 'possession',
    name: 'Possession',
    blurb: 'Short passes: everyone comes close to show for the ball, 2 and 3 push up.',
    jobs: jobs(
      { x: -13, follow: 0.3, ahead: -5, min: -12, max: -1, top: 12, roam: 4, near: 6, runs: 0, rest: true, overlap: 8 },
      { x: -12, follow: 0.25, ahead: 3, min: -3, max: 9, top: HALF_L - 10, roam: 6, near: 6, runs: 0.2 },
      { x: 0, follow: 0.45, ahead: 6, min: 1, max: 12, top: HALF_L - 8, roam: 6, near: 7, runs: 0.3 },
      { x: 0, follow: 0.45, ahead: -2, min: -7, max: 3, top: 18, roam: 5, near: 5, runs: 0 },
    ),
    space: 7,
    far: 16,
    w: { open: 1, lane: 1, prog: 0.25, goal: 0.8 },
    runners: 1,
    passEager: 3.5,
    passForward: 0.18,
    through: 0.5,
    loft: false,
  },
  direct: {
    id: 'direct',
    name: 'Direct',
    blurb: 'Through balls: 5, 6 and 7 sprint in behind, the 4 arrives late in the box.',
    jobs: jobs(
      { x: -9, follow: 0.25, ahead: -11, min: -18, max: -6, top: 4, roam: 4, near: 8, runs: 0, rest: true, overlap: 3 },
      { x: -15, follow: 0.2, ahead: 11, min: 3, max: 20, top: HALF_L - 7, roam: 7, near: 10, runs: 0.9 },
      { x: 0, follow: 0.3, ahead: 16, min: 7, max: 24, top: HALF_L - 5, roam: 7, near: 12, runs: 1 },
      { x: 0, follow: 0.35, ahead: 0, min: -6, max: 9, top: HALF_L - 11, roam: 7, near: 7, runs: 0.35 },
    ),
    space: 9,
    far: 30,
    w: { open: 0.7, lane: 0.45, prog: 0.8, goal: 2 },
    runners: 2,
    passEager: 5,
    passForward: 0.35,
    through: 3,
    loft: true,
  },
};

export function isTactic(v: unknown): v is Tactic {
  return typeof v === 'string' && (TACTIC_IDS as readonly string[]).includes(v);
}
