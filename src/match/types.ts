// Shared 6v6 types and pitch geometry (metres).
// Team 0 defends y = -HALF_L and attacks +y. Team 1 the opposite.

import type { Zone } from '../duel/goal';

export const HALF_W = 20;
export const HALF_L = 30;
export const GOAL_HALF = 3;
export const BOX_HALF_W = 9;
export const BOX_DEPTH = 8;
export const SIX_HALF_W = 5;
export const SIX_DEPTH = 3.5;
export const PLAYER_R = 0.6;
export const BALL_R = 0.25;
export const PLAYERS_PER_TEAM = 6;
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export type Team = 0 | 1;
export type MatchState = 'kickoff' | 'play' | 'duel' | 'goal' | 'ended';
export type ShotArea = 'own' | 'long' | 'danger' | 'impossible';

export interface Player {
  team: Team;
  /** 0 = goalkeeper, 1..5 field players. */
  role: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing direction (unit vector). */
  fx: number;
  fy: number;
  sprinting: boolean;
  /** Seconds this player cannot tackle / be tackled. */
  tackleCd: number;
  protect: number;
  /** Human slot controlling this player, or -1 for AI. */
  human: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Height above ground (only used for shots, for drawing). */
  z: number;
  owner: number;
  lastTouch: number;
  /** Intended receiver of a pass in flight, or -1. */
  passTarget: number;
}

export interface Duel {
  shooter: number;
  team: Team;
  area: ShotArea;
  zone: Zone;
  /** Where the ball crosses the goal line. */
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  tick: number;
  /** Keeper's choice: undefined = not yet decided, null = stayed. */
  dive: Zone | null | undefined;
  keeperHuman: boolean;
  outcome: 'goal' | 'saved' | null;
}

/** What one human sends every tick. */
export interface Input {
  /** Joystick, magnitude 0..1. Magnitude >= SPRINT_AT means "over-extended". */
  mx: number;
  my: number;
  pass: boolean;
  shoot: boolean;
  /** Dive during a save: zone index 0..5, 6 = stay, -1 none. */
  dive: number;
}

export const SPRINT_AT = 0.95;

export const NO_INPUT: Input = { mx: 0, my: 0, pass: false, shoot: false, dive: -1 };

export type MatchEvent =
  | { type: 'kick'; x: number; y: number; power: number }
  | { type: 'pass'; from: number; to: number }
  | { type: 'steal'; by: number }
  | { type: 'shot'; by: number; area: ShotArea }
  | { type: 'goal'; team: Team; by: number }
  | { type: 'save'; by: number }
  | { type: 'whistle'; long: boolean }
  | { type: 'bounce' };

/** Goal y for the goal a team attacks. */
export function attackGoalY(team: Team): number {
  return team === 0 ? HALF_L : -HALF_L;
}

/** Classifies a shooting position for the team attacking `team`'s direction. */
export function shotArea(team: Team, x: number, y: number): ShotArea {
  const depth = team === 0 ? HALF_L - y : y + HALF_L; // distance to the goal line being attacked
  if (depth > HALF_L) return 'own';
  if (Math.abs(x) <= SIX_HALF_W && depth <= SIX_DEPTH) return 'impossible';
  if (Math.abs(x) <= BOX_HALF_W && depth <= BOX_DEPTH) return 'danger';
  return 'long';
}
