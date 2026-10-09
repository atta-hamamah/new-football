// Aim wobble: the reticle drifts, more towards the corners and the longer you hold.
// Releasing at the right moment is the shooting skill.

import { GOAL_H, GOAL_HALF_W, type Point } from './goal';

export function swayAmplitude(aim: Point, swayMult: number, holdTime: number): number {
  const ex = Math.min(1, Math.abs(aim.x) / GOAL_HALF_W);
  const ey = Math.min(1, Math.max(0, aim.y) / GOAL_H);
  const corner = ex * ex * 0.65 + ey * ey * 0.35;
  const nerves = 1 + Math.min(holdTime, 4) * 0.18;
  return swayMult * (0.1 + 0.62 * corner) * nerves;
}

/** Smooth, non-repeating-looking drift. `t` in seconds. */
export function swayOffset(t: number, amp: number): Point {
  return {
    x: amp * (0.7 * Math.sin(t * 2.1) + 0.3 * Math.sin(t * 5.3 + 1.3)),
    y: amp * 0.6 * (0.7 * Math.sin(t * 2.7 + 0.6) + 0.3 * Math.sin(t * 4.1 + 2.1)),
  };
}
