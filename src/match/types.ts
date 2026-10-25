// Shared 7v7 types and pitch geometry (metres).
// Team 0 defends y = -HALF_L and attacks +y. Team 1 the opposite.

import type { Zone } from '../duel/goal';

export const HALF_W = 22;
export const HALF_L = 33;
export const GOAL_HALF = 3;
export const BOX_HALF_W = 9;
export const BOX_DEPTH = 8;
export const SIX_HALF_W = 5;
export const SIX_DEPTH = 3.5;
export const PLAYER_R = 0.6;
/** Radius players are drawn at (bigger than PLAYER_R so they read on a phone). Discs that look touching are touching. */
export const DISC_R = 0.78;
export const BALL_R = 0.25;
export const PLAYERS_PER_TEAM = 7;
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export type Team = 0 | 1;
export type MatchState = 'kickoff' | 'play' | 'duel' | 'goal' | 'ended';
export type ShotArea = 'own' | 'long' | 'danger' | 'impossible';

export interface Player {
  team: Team;
  /** 0 = goalkeeper, 1..6 field players. */
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
  /** Seconds this player is off balance (just lost the ball): no control. */
  stun: number;
  /** Human slot controlling this player, or -1 for AI. */
  human: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Height above ground (lofted passes and shots). */
  z: number;
  vz: number;
  /** A lofted ball that hasn't come down yet: nobody can touch it until it lands. */
  flying: boolean;
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
  /** Shot power 0..1 (from how long SHOOT was held). 1 = fireball. */
  power: number;
  /** Ticks the ball takes to reach the goal (faster shots = fewer). */
  ticks: number;
  /** Ticks a human keeper has to choose a dive. */
  window: number;
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

/** Seconds of holding SHOOT for a full-power shot. */
export const CHARGE_TIME = 0.9;
/** Power of a quick tap. */
export const MIN_SHOT_POWER = 0.3;
/** At or above this power the ball is a fireball. */
export const FIREBALL = 0.98;

export function chargeToPower(seconds: number): number {
  return MIN_SHOT_POWER + (1 - MIN_SHOT_POWER) * Math.min(1, seconds / CHARGE_TIME);
}

/** Holding PASS longer than this starts filling the long-ball meter (shorter = a plain tap). */
export const PASS_TAP = 0.18;
/** Seconds of holding PASS to fill the meter. Released full = lofted long ball, otherwise a ground pass. */
export const PASS_CHARGE_TIME = 0.8;

/** Long-ball meter 0..1 after holding PASS for `seconds`. */
export function passCharge(seconds: number): number {
  return Math.min(1, Math.max(0, seconds - PASS_TAP) / (PASS_CHARGE_TIME - PASS_TAP));
}

/** Whether PASS held for `seconds` fills the meter: a long ball. */
export function isLongBall(seconds: number): boolean {
  return passCharge(seconds) >= 0.999;
}

/** A long ball looks for the teammate that way whose distance best matches this (metres): the far one. */
export const LONG_BALL_RANGE = 40;

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
