// One kick of a shootout, as pure functions: the UI prepares a kick, gets the player's
// input (aim point or dive), then resolves it. Bots in tests use the same functions.

import { gaussian } from '../core/rng';
import { type AiShot, keeperDive, keeperGuess, makeTell, shooterShot, type Tell } from '../duel/ai';
import { type Point, ZONES, zoneCenter, zoneIndex, zoneOf } from '../duel/goal';
import { type Resolution, resolveShot, type Shot } from '../duel/resolve';
import type { Run } from './run';

export interface ShotPrep {
  /** Zone the keeper has already committed to. */
  keeperZone: number;
  tell: Tell;
}

export function prepareShot(run: Run): ShotPrep {
  const k = run.opponent.keeper;
  const keeperZone = keeperGuess(k, run.history, run.rng);
  const tell = makeTell(ZONES[keeperZone].col, k.honesty + run.stats.readKeeper, run.rng);
  return { keeperZone, tell };
}

export interface ShotResult extends Resolution {
  shot: Shot;
}

/** `aim` is where the player released the reticle (after wobble), in goal metres. */
export function takeShot(run: Run, prep: ShotPrep, aim: Point): ShotResult {
  const s = run.stats;
  const shot: Shot = {
    x: aim.x + gaussian(run.rng) * s.shotError,
    y: Math.max(0.11, aim.y + gaussian(run.rng) * s.shotError * 0.6),
    speed: s.shotSpeed,
  };
  run.history[zoneIndex(zoneOf(aim))]++;
  const res = resolveShot(shot, keeperDive(run.opponent.keeper, prep.keeperZone), { postIn: s.postIn, cornerBonus: s.cornerBonus });
  return { ...res, shot };
}

export function prepareSave(run: Run, kickNumber: number): AiShot {
  const shooters = run.opponent.shooters;
  return shooterShot(shooters[kickNumber % shooters.length], run.rng, run.stats.readShooter);
}

/** Standing still (no dive in time) covers the middle of the goal. */
export const STAND: Point = { x: 0, y: 0.95 };

/** `zone` is the dive the player chose, or null if they did not react in time. */
export function makeSave(run: Run, ai: AiShot, zone: number | null): Resolution {
  const s = run.stats;
  const target = zone === null ? STAND : zoneCenter(ZONES[zone]);
  const reach = zone === null ? s.keeperReach * 0.85 : s.keeperReach;
  return resolveShot(ai.shot, { target, reach, adjust: s.keeperAdjust });
}
