// Goal geometry, in metres. Origin: centre of the goal line on the ground.
// x runs left (-) to right (+) as seen by the penalty taker, y is height.

export const GOAL_HALF_W = 3.66;
export const GOAL_H = 2.44;
export const BALL_R = 0.11;
export const PENALTY_DIST = 11;

export type Col = -1 | 0 | 1;
export type Row = 0 | 1;

export interface Zone {
  col: Col;
  row: Row;
}

export interface Point {
  x: number;
  y: number;
}

/** The six classic penalty zones. Index = row * 3 + col + 1. */
export const ZONES: readonly Zone[] = [
  { col: -1, row: 0 },
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: -1, row: 1 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
];

export const ZONE_NAMES = ['bottom left', 'low middle', 'bottom right', 'top left', 'high middle', 'top right'];

export function zoneIndex(z: Zone): number {
  return z.row * 3 + z.col + 1;
}

/** Where a keeper aims his body when diving to a zone. */
export function zoneCenter(z: Zone): Point {
  return { x: z.col * 1.9, y: z.row ? 1.55 : 0.5 };
}

export function zoneOf(p: Point): Zone {
  const col: Col = p.x < -GOAL_HALF_W / 3 ? -1 : p.x > GOAL_HALF_W / 3 ? 1 : 0;
  const row: Row = p.y > GOAL_H / 2 ? 1 : 0;
  return { col, row };
}

export function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
