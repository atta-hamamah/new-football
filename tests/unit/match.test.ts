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

  it('shot power: weak shots from range are saved, a full-power fireball beats the middle rule', () => {
    expect(resolveDuel('long', { col: 1, row: 0 }, { col: -1, row: 0 }, 0.35)).toBe('saved');
    expect(resolveDuel('long', { col: 0, row: 0 }, { col: 1, row: 0 }, 0.9)).toBe('saved');
    expect(resolveDuel('long', { col: 0, row: 0 }, { col: 1, row: 0 }, 1)).toBe('goal');
    expect(resolveDuel('long', { col: 0, row: 0 }, { col: 0, row: 0 }, 1)).toBe('saved');
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

describe('charged shots', () => {
  function ready() {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    for (let i = 0; i < 70; i++) sim.step(new Map([[0, NO_INPUT]]));
    const me = sim.humans.get(0)!.controlled;
    place(sim, me, 2, 12); // opponent half, outside the box
    for (const p of sim.players) if (p.team === 1 && p.role) Object.assign(p, { x: 18, y: -20 });
    giveBall(sim, me);
    return sim;
  }
  const hold = (sim: MatchSim, ticks: number, inp: Partial<Input>) => {
    for (let t = 0; t < ticks; t++) sim.step(new Map([[0, { ...NO_INPUT, shoot: true, ...inp }]]));
    sim.step(new Map([[0, { ...NO_INPUT, ...inp, shoot: false }]]));
  };

  it('a tap is a weak shot, holding charges to full power (fireball)', () => {
    const tap = ready();
    hold(tap, 1, {});
    expect(tap.state).toBe('duel');
    expect(tap.duel!.power).toBeLessThan(0.35);

    const full = ready();
    expect(full.chargeOf(full.humans.get(0)!.controlled)).toBe(-1);
    hold(full, 60, {});
    expect(full.duel!.power).toBe(1);
    // Harder shots reach the goal sooner and leave the keeper less time.
    expect(full.duel!.ticks).toBeLessThan(tap.duel!.ticks);
    expect(full.duel!.window).toBeLessThan(tap.duel!.window);
  });

  it('the held stick picks the side; pushed to the edge goes high', () => {
    const sim = ready();
    hold(sim, 20, { mx: -0.7, my: 0.2 });
    expect(sim.duel!.zone).toEqual({ col: -1, row: 0 });
    const high = ready();
    hold(high, 20, { mx: 1, my: 0 });
    expect(high.duel!.zone).toEqual({ col: 1, row: 1 });
  });

  it('shows the charge while holding', () => {
    const sim = ready();
    const me = sim.humans.get(0)!.controlled;
    for (let t = 0; t < 27; t++) sim.step(new Map([[0, { ...NO_INPUT, shoot: true }]]));
    expect(sim.chargeOf(me)).toBeGreaterThan(0.4);
    expect(sim.chargeOf(me)).toBeLessThan(0.6);
  });
});

describe('human keeper dives with the stick', () => {
  it('when time runs out, the keeper dives where the stick points', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'keeper side');
    sim.state = 'play';
    // Opponent shoots at team 0's goal.
    const shooter = 11;
    place(sim, shooter, 0, -12);
    giveBall(sim, shooter);
    expect(sim.shoot(shooter, 1, false, 0.8)).toBe(true);
    expect(sim.duel!.keeperHuman).toBe(true);
    while ((sim.state as string) === 'duel') sim.step(new Map([[0, { ...NO_INPUT, mx: 0.8, my: 0 }]]));
    expect(sim.duel!.dive).toEqual({ col: 1, row: 0 });
    expect(sim.duel!.outcome).toBe('saved');
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
