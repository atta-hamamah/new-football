// Keeper and shooter personalities. Every opponent has habits you can learn to read:
// favourite zones, how honest their body language ("tell") is, and how well they react.

import { gaussian, Rng, weightedIndex } from '../core/rng';
import { GOAL_H, GOAL_HALF_W, type Col, type Point, type Zone, ZONES, zoneCenter } from './goal';
import type { Dive, Shot } from './resolve';

export interface KeeperProfile {
  id: string;
  name: string;
  /** One-line hint shown to the player before the match. */
  trait: string;
  reach: number;
  /** Probability his pre-shot lean points the way he will actually dive. */
  honesty: number;
  /** Preference per zone (6 weights). */
  bias: number[];
  /** 0..1: how much he adapts to where you have been shooting. */
  learn: number;
  /** 0..1: late correction towards the ball. */
  adjust: number;
}

export interface ShooterProfile {
  name: string;
  /** Ball speed, m/s. */
  speed: number;
  /** Aiming error (standard deviation, metres). */
  error: number;
  bias: number[];
  /** Probability his run-up lean points to his real side. */
  honesty: number;
  /** 0..1: how close to the posts/bar he dares to aim. */
  edge: number;
}

export interface Tell {
  /** Direction of the lean as seen by the penalty taker. */
  col: Col;
  /** 0..1 visual strength. */
  strength: number;
}

const U = [1, 1, 1, 1, 1, 1];

export const KEEPERS: Record<string, KeeperProfile> = {
  rookie: {
    id: 'rookie',
    name: 'The Rookie',
    trait: 'Nervous. His lean usually gives him away.',
    reach: 1.1,
    honesty: 0.8,
    bias: U,
    learn: 0,
    adjust: 0,
  },
  wall: {
    id: 'wall',
    name: 'The Wall',
    trait: 'Loves to stay in the middle. Go for the corners.',
    reach: 1.3,
    honesty: 0.55,
    bias: [0.7, 3, 0.7, 0.6, 2.2, 0.6],
    learn: 0,
    adjust: 0.05,
  },
  leaper: {
    id: 'leaper',
    name: 'The Leaper',
    trait: 'Always throws himself to his favourite side.',
    reach: 1.3,
    honesty: 0.65,
    bias: [2.6, 0.5, 0.8, 2.2, 0.4, 0.7],
    learn: 0.1,
    adjust: 0,
  },
  analyst: {
    id: 'analyst',
    name: 'The Analyst',
    trait: 'Studies where you shoot. Change it up.',
    reach: 1.28,
    honesty: 0.45,
    bias: U,
    learn: 0.75,
    adjust: 0.05,
  },
  cat: {
    id: 'cat',
    name: 'The Cat',
    trait: 'Guesses badly, but reacts fast. Hit it hard and wide.',
    reach: 1.15,
    honesty: 0.5,
    bias: U,
    learn: 0.2,
    adjust: 0.28,
  },
  gambler: {
    id: 'gambler',
    name: 'The Gambler',
    trait: 'Big obvious lean... but he bluffs half the time.',
    reach: 1.35,
    honesty: 0.4,
    bias: [1.4, 0.6, 1.4, 1.2, 0.4, 1.2],
    learn: 0.2,
    adjust: 0,
  },
  octopus: {
    id: 'octopus',
    name: 'The Octopus',
    trait: 'BOSS. Enormous reach. Only perfect placement beats him.',
    reach: 1.6,
    honesty: 0.5,
    bias: [1, 1.2, 1, 0.9, 1, 0.9],
    learn: 0.3,
    adjust: 0.1,
  },
  legend: {
    id: 'legend',
    name: 'The Legend',
    trait: 'FINAL BOSS. Reads you, reacts late, bluffs often.',
    reach: 1.45,
    honesty: 0.3,
    bias: U,
    learn: 0.6,
    adjust: 0.2,
  },
};

export const NORMAL_KEEPERS = ['rookie', 'wall', 'leaper', 'analyst', 'cat', 'gambler'];

/** Mirrors a 6-zone weight table left/right (so "favourite side" varies per opponent). */
export function mirrorBias(b: number[]): number[] {
  return [b[2], b[1], b[0], b[5], b[4], b[3]];
}

/** How likely the keeper is to dive to each zone, given your shooting history. */
export function keeperWeights(k: KeeperProfile, history: readonly number[]): number[] {
  const total = history.reduce((a, b) => a + b, 0);
  const biasSum = k.bias.reduce((a, b) => a + b, 0);
  return k.bias.map((b, i) => {
    const prior = b / biasSum;
    const learned = (history[i] + 0.5) / (total + 3);
    return prior * (1 - k.learn) + learned * k.learn;
  });
}

/** The keeper commits to a zone before the shot (like a real penalty). */
export function keeperGuess(k: KeeperProfile, history: readonly number[], rng: Rng): number {
  return weightedIndex(rng, keeperWeights(k, history));
}

export function makeTell(realCol: Col, honesty: number, rng: Rng): Tell {
  const honest = rng.chance(Math.min(0.95, honesty));
  let col = realCol;
  if (!honest) {
    const others = ([-1, 0, 1] as Col[]).filter((c) => c !== realCol);
    col = others[rng.int(0, others.length - 1)];
  }
  return { col, strength: 0.6 + rng.next() * 0.4 };
}

export function keeperDive(k: KeeperProfile, zone: number): Dive {
  return { target: zoneCenter(ZONES[zone]), reach: k.reach, adjust: k.adjust };
}

export interface AiShot {
  zone: number;
  shot: Shot;
  tell: Tell;
}

/** An AI penalty taker picks a zone, shows a (maybe fake) lean in the run-up, and shoots. */
export function shooterShot(s: ShooterProfile, rng: Rng, honestyBonus = 0): AiShot {
  const zone = weightedIndex(rng, s.bias);
  const z: Zone = ZONES[zone];
  const target: Point = {
    x: z.col * GOAL_HALF_W * s.edge * (0.88 + rng.next() * 0.12) + (z.col === 0 ? (rng.next() - 0.5) * 0.8 : 0),
    y: z.row ? GOAL_H * (0.62 + s.edge * 0.3 * (0.85 + rng.next() * 0.15)) : 0.18 + rng.next() * 0.45,
  };
  const shot: Shot = {
    x: target.x + gaussian(rng) * s.error,
    y: Math.max(0.11, target.y + gaussian(rng) * s.error * 0.6),
    speed: s.speed * (0.94 + rng.next() * 0.12),
  };
  return { zone, shot, tell: makeTell(z.col, s.honesty + honestyBonus, rng) };
}
