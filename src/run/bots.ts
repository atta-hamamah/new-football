// Simulated players, used to balance the game and in tests. They play through the
// exact same kick functions as a human, with human-like limitations.

import { Rng } from '../core/rng';
import { swayAmplitude, swayOffset } from '../duel/aim';
import { type Col, type Point, zoneIndex } from '../duel/goal';
import type { Outcome } from '../duel/resolve';
import { makeSave, prepareSave, prepareShot, takeShot } from './kick';
import { Run } from './run';
import { Shootout } from './shootout';

export type BotSkill = 'random' | 'casual' | 'smart';

function otherCol(rng: Rng, c: Col): Col {
  const o = ([-1, 0, 1] as Col[]).filter((x) => x !== c);
  return o[rng.int(0, 1)];
}

function botAim(rng: Rng, skill: BotSkill, tellCol: Col): Point {
  if (skill === 'random') return { x: rng.range(-3.4, 3.4), y: rng.range(0.15, 2.3) };
  // Shoot away from the lean; smart bots trust it more and aim tighter.
  const trust = skill === 'smart' ? 0.85 : 0.5;
  const col: Col = rng.chance(trust)
    ? tellCol === 0
      ? rng.chance(0.5)
        ? -1
        : 1
      : otherCol(rng, tellCol)
    : ([-1, 0, 1] as Col[])[rng.int(0, 2)];
  const edge = skill === 'smart' ? 0.82 : 0.7;
  const high = rng.chance(0.5);
  return { x: col * 3.66 * edge + rng.range(-0.25, 0.25), y: high ? 2.44 * edge : 0.35 };
}

export function botKickShot(run: Run, rng: Rng, skill: BotSkill, streak: boolean): Outcome {
  const prep = prepareShot(run);
  const aim = botAim(rng, skill, prep.tell.col);
  const hold = rng.range(0.6, 2.5);
  const amp = streak ? 0 : swayAmplitude(aim, run.stats.sway, hold);
  // Smart players release when the reticle is near its centre.
  const phase = skill === 'smart' ? rng.range(0, 0.5) : rng.range(0, 1);
  const off = swayOffset(hold, amp * phase);
  return takeShot(run, prep, { x: aim.x + off.x, y: aim.y + off.y }).outcome;
}

export function botKickSave(run: Run, rng: Rng, skill: BotSkill, kick: number): Outcome {
  const ai = prepareSave(run, kick);
  const s = run.stats;
  let zone: number | null;
  if (skill === 'random') zone = rng.int(0, 5);
  else {
    const reacts = rng.chance(skill === 'smart' ? 0.92 : 0.8);
    if (!reacts) zone = null;
    else {
      // How much of the ball's flight a human sees before they must decide.
      const pRead = Math.min(0.85, 0.3 + (s.reactionWindow - 0.3) * 0.9 + (0.32 - s.slowmo) * 0.6 + (skill === 'smart' ? 0.1 : 0));
      const realCol = ai.shot.x < -1.22 ? -1 : ai.shot.x > 1.22 ? 1 : 0;
      const col: Col = rng.chance(pRead) ? realCol : rng.chance(0.6) ? ai.tell.col : ([-1, 0, 1] as Col[])[rng.int(0, 2)];
      const realRow = ai.shot.y > 1.22 ? 1 : 0;
      const row = rng.chance(0.6) ? realRow : rng.int(0, 1);
      zone = zoneIndex({ col, row: row as 0 | 1 });
    }
  }
  return makeSave(run, ai, zone).outcome;
}

/** Plays one full shootout; returns true if the bot won. */
export function botMatch(run: Run, rng: Rng, skill: BotSkill): boolean {
  const so = new Shootout();
  let kick = 0;
  let retakes = run.stats.retakes;
  let streak = false;
  while (so.next) {
    if (so.next === 'you') {
      let out = botKickShot(run, rng, skill, streak);
      if (out !== 'goal' && retakes > 0) {
        retakes--;
        out = botKickShot(run, rng, skill, false);
      }
      streak = run.stats.hotStreak && out === 'goal';
      so.record('you', out === 'goal');
    } else {
      const out = botKickSave(run, rng, skill, kick++);
      so.record('them', out === 'goal');
    }
  }
  return so.winner === 'you';
}

/** Plays a whole run, picking upgrades with a simple preference. Returns stages won. */
export function botRun(seed: number, skill: BotSkill): Run {
  const run = new Run(seed);
  const rng = new Rng(seed ^ 0x5bd1e995);
  while (run.status === 'playing') {
    run.finishMatch(botMatch(run, rng, skill));
    if (run.pendingOffers) run.pickUpgrade(run.pendingOffers[rng.int(0, run.pendingOffers.length - 1)].id);
  }
  return run;
}
