// Simple pinhole camera behind the penalty spot, looking at the goal.
// World: X right, Y up (metres), Z = distance from the camera.

import { VIEW_W } from './app';

export const FOCAL = 1229;
export const HORIZON = 450;
export const CAM_H = 1.6;
export const SPOT_Z = 4;
export const GOAL_Z = 15;

export interface Projected {
  x: number;
  y: number;
  /** Pixels per metre at this depth. */
  s: number;
}

export function project(X: number, Y: number, Z: number): Projected {
  const s = FOCAL / Z;
  return { x: VIEW_W / 2 + X * s, y: HORIZON + (CAM_H - Y) * s, s };
}

/** Pixels per metre on the goal line. */
export const GOAL_SCALE = FOCAL / GOAL_Z;
