import { describe, expect, it } from 'vitest';
import { MatchSim, resolveDuel } from '../../src/match/sim';
import { type Input, NO_INPUT, shotArea } from '../../src/match/types';

const cfg = { duration: 60, difficulty: 1, seed: 7 };

function place(sim: MatchSim, i: number, x: number, y: number) {
  Object.assign(sim.players[i], { x, y, vx: 0, vy: 0 });
}

/** Puts the ball at player i's feet and starts open play. */
function giveBall(sim: MatchSim, i: number) {
  sim.state = 'play';
  Object.assign(sim.ball, { owner: i, lastTouch: i, passTarget: -1 });
  sim.players[i].protect = 5;
}

describe('shot areas and rules', () => {
  it('classifies positions for both attacking directions', () => {
    expect(shotArea(0, 0, -5)).toBe('own');
    expect(shotArea(0, 0, 10)).toBe('long');
    expect(shotArea(0, 6, 25)).toBe('danger');
    expect(shotArea(0, 1, 28)).toBe('impossible');
    expect(shotArea(1, 1, -28)).toBe('impossible');
    expect(shotArea(1, 0, 10)).toBe('own');
  });

  it('long shots: direction must match, middle is always saved', () => {
    expect(resolveDuel('long', { col: 0, row: 1 }, { col: 1, row: 0 })).toBe('saved');
    expect(resolveDuel('long', { col: 1, row: 0 }, { col: 1, row: 1 })).toBe('saved');
    expect(resolveDuel('long', { col: 1, row: 0 }, { col: -1, row: 0 })).toBe('goal');
  });

  it('danger area: direction and height must match; six-yard box always scores', () => {
    expect(resolveDuel('danger', { col: -1, row: 1 }, { col: -1, row: 0 })).toBe('goal');
    expect(resolveDuel('danger', { col: -1, row: 1 }, { col: -1, row: 1 })).toBe('saved');
    expect(resolveDuel('impossible', { col: 0, row: 0 }, { col: 0, row: 0 })).toBe('goal');
  });

  it('cannot shoot from your own half', () => {
    const sim = new MatchSim(cfg);
    place(sim, 3, 0, -8);
    giveBall(sim, 3);
    expect(sim.shoot(3, 1, false)).toBe(false);
    expect(sim.state).toBe('play');
  });
});

describe('passing rules', () => {
  function setup() {
    const sim = new MatchSim(cfg);
    // Carrier in the middle; teammates around.
    place(sim, 3, 0, 0);
    place(sim, 1, -5, 0); // near left
    place(sim, 2, -15, 0); // far left
    place(sim, 4, 0, 6); // near ahead
    place(sim, 5, 0, -20); // far behind
    for (let i = 6; i < 12; i++) place(sim, i, 18, 25 - i);
    giveBall(sim, 3);
    return sim;
  }

  it('no direction: nearest teammate', () => {
    const sim = setup();
    sim.pass(3, 0, 0);
    expect(sim.ball.passTarget).toBe(1);
  });

  it('with direction: nearest teammate that way', () => {
    const sim = setup();
    sim.pass(3, 0, 0.6);
    expect(sim.ball.passTarget).toBe(4);
  });

  it('over-extended: farthest teammate that way', () => {
    const sim = setup();
    sim.pass(3, -1, 0);
    expect(sim.ball.passTarget).toBe(2);
    const sim2 = setup();
    sim2.pass(3, -0.5, 0);
    expect(sim2.ball.passTarget).toBe(1);
  });
});

describe('human control', () => {
  it('controls the ball carrier and follows passes', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    const striker = 5;
    expect(sim.humans.get(0)!.controlled).toBe(striker); // kickoff taker
    // Run the kickoff freeze.
    for (let i = 0; i < 70; i++) sim.step(new Map([[0, NO_INPUT]]));
    const press = (inp: Partial<Input>) => sim.step(new Map([[0, { ...NO_INPUT, ...inp }]]));
    press({ pass: true });
    const target = sim.ball.passTarget;
    expect(target).toBeGreaterThan(0);
    expect(sim.humans.get(0)!.controlled).toBe(target);
  });

  it('sprint locks the direction until the stick leaves the edge', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    for (let i = 0; i < 70; i++) sim.step(new Map([[0, NO_INPUT]]));
    const me = sim.players[sim.humans.get(0)!.controlled];
    for (let i = 0; i < 20; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 1, my: 0 }]]));
    expect(me.sprinting).toBe(true);
    // Pushing to the edge in another direction keeps the old direction.
    for (let i = 0; i < 20; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 0, my: 1 }]]));
    expect(me.fx).toBeCloseTo(1, 5);
    expect(Math.abs(me.vy)).toBeLessThan(0.5);
  });
});

describe('computer vs computer', () => {
  it('plays sensible matches: passes, shots, goals, ball always in bounds', () => {
    let goals = 0;
    let shots = 0;
    let passes = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const sim = new MatchSim({ duration: 120, difficulty: 1, seed });
      let guard = 0;
      while (sim.state !== 'ended' && guard++ < 60 * 300) {
        for (const e of sim.step()) {
          if (e.type === 'goal') goals++;
          if (e.type === 'shot') shots++;
          if (e.type === 'pass') passes++;
        }
        expect(Number.isFinite(sim.ball.x) && Number.isFinite(sim.ball.y)).toBe(true);
        expect(Math.abs(sim.ball.x)).toBeLessThanOrEqual(20.01);
        expect(Math.abs(sim.ball.y)).toBeLessThanOrEqual(30.01);
      }
      expect(sim.state).toBe('ended');
    }
    expect(passes).toBeGreaterThan(200);
    expect(shots).toBeGreaterThan(3);
    expect(goals).toBeGreaterThan(1);
  });
});
