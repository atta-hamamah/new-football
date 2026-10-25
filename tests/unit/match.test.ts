import { describe, expect, it } from 'vitest';
import { MatchSim, PASS_SPEED, resolveDuel } from '../../src/match/sim';
import { type Tactic, TACTIC_IDS } from '../../src/match/tactics';
import { HALF_L, HALF_W, type Input, NO_INPUT, PASS_CHARGE_TIME, PLAYERS_PER_TEAM, shotArea } from '../../src/match/types';

const cfg = { duration: 60, difficulty: 1, seed: 7 };
/** Index of team 1's first player (its keeper); team 1 role r is T + r. */
const T = PLAYERS_PER_TEAM;

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
    expect(shotArea(0, 6, HALF_L - 5)).toBe('danger');
    expect(shotArea(0, 1, HALF_L - 2)).toBe('impossible');
    expect(shotArea(1, 1, -HALF_L + 2)).toBe('impossible');
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
    place(sim, 6, 12, -12); // out of the way
    for (let i = T; i < 2 * T; i++) place(sim, i, 18, 25 - i);
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

  it('a stick pushed to the edge still means the nearest teammate that way', () => {
    const sim = setup();
    sim.pass(3, -1, 0);
    expect(sim.ball.passTarget).toBe(1);
  });

  it('a slightly off-line teammate is still found', () => {
    const sim = setup();
    // Up-left diagonal: nobody is exactly there, the near-left player is within the cone.
    sim.pass(3, -0.6, 0.45);
    expect(sim.ball.passTarget).toBe(1);
  });

  it('long ball: goes to the far teammate that way and flies over defenders', () => {
    const sim = setup();
    sim.pass(3, -1, 0, -1, true);
    expect(sim.ball.passTarget).toBe(2);
    expect(sim.ball.vz).toBeGreaterThan(0);
    let owner = -1;
    for (let t = 0; t < 240 && owner < 0; t++) {
      // A defender stands still on the line to the far-left teammate.
      place(sim, T + 1, -6, 0);
      sim.step();
      owner = sim.ball.owner;
    }
    expect(owner).toBe(2);
  });

  it('nobody can touch a long ball until it lands, not even a player right under it', () => {
    const sim = setup();
    sim.pass(3, -1, 0, -1, true);
    let t = 0;
    while (sim.ball.flying && t++ < 240) {
      // An opponent shadows the ball the whole way; the receiver is kept away from where it lands.
      place(sim, T + 1, sim.ball.x, sim.ball.y);
      place(sim, 2, -15, 15);
      sim.step();
      if (sim.ball.flying) expect(sim.ball.owner).toBe(-1);
    }
    expect(sim.ball.flying).toBe(false);
    // Once it is down, whoever is there takes it.
    place(sim, T + 1, sim.ball.x, sim.ball.y);
    sim.step();
    expect(sim.ball.owner).toBe(T + 1);
  });

  it('ground passes are quick and reach the receiver', () => {
    const sim = setup();
    sim.pass(3, -0.5, 0);
    expect(Math.hypot(sim.ball.vx, sim.ball.vy)).toBeGreaterThanOrEqual(14);
    let t = 0;
    while (sim.ball.owner < 0 && t < 120) {
      sim.step();
      t++;
    }
    expect(sim.ball.owner).toBe(1);
    expect(t).toBeLessThan(30); // 5 m in under half a second
  });

  it('every ground pass has the same pace, short or long', () => {
    const near = setup();
    near.pass(3, -0.5, 0);
    const far = setup();
    far.pass(3, 0, -1);
    expect(far.ball.passTarget).toBe(5);
    for (const sim of [near, far]) {
      for (let t = 0; t < 10; t++) sim.step();
      expect(Math.hypot(sim.ball.vx, sim.ball.vy)).toBeCloseTo(PASS_SPEED, 5);
    }
  });

  /** Steps until someone has the ball (or the pass gives up), forcing `each` every tick. */
  function untilTaken(sim: MatchSim, each: () => void = () => {}) {
    for (let t = 0; t < 400 && sim.ball.owner < 0; t++) {
      each();
      sim.step();
    }
    return sim.ball.owner;
  }

  it('a ground pass finds a receiver who keeps running away', () => {
    const sim = setup();
    sim.pass(3, 0, -1);
    const target = sim.ball.passTarget;
    // The receiver sprints off sideways the moment the ball is played.
    const owner = untilTaken(sim, () => Object.assign(sim.players[target], { vx: 9, vy: 0 }));
    expect(owner).toBe(target);
  });

  it("a pass is played into the receiver's run, and they keep running onto it", () => {
    const sim = setup();
    // The near-ahead teammate is running right.
    Object.assign(sim.players[4], { vx: 6, vy: 0 });
    sim.pass(3, 0, 0.6);
    expect(sim.ball.passTarget).toBe(4);
    // Aimed ahead of them, not straight at where they stand (straight up the pitch).
    expect(sim.ball.vx).toBeGreaterThan(3);
    expect(untilTaken(sim)).toBe(4);
    expect(sim.players[4].vx).toBeGreaterThan(4);
  });

  it('control stays on the passer until the ball is about to reach the receiver', () => {
    const sim = setup();
    sim.addHuman(0, 0, 'you');
    sim.assignControl(true);
    const h = sim.humans.get(0)!;
    expect(h.controlled).toBe(3);
    sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
    sim.step(new Map([[0, { ...NO_INPUT, my: -0.6 }]])); // released towards the far one behind
    expect(sim.ball.passTarget).toBe(5);
    let switchedEarly = false;
    while (sim.ball.owner < 0) {
      const d = Math.hypot(sim.players[5].x - sim.ball.x, sim.players[5].y - sim.ball.y);
      if (d > 7) expect(h.controlled).toBe(3);
      if (h.controlled === 5) switchedEarly = true;
      sim.step(new Map([[0, NO_INPUT]]));
    }
    expect(sim.ball.owner).toBe(5);
    expect(switchedEarly).toBe(true); // just before the ball got there, not only on the touch
    expect(h.controlled).toBe(5);
  });

  it('a teammate standing in the way lets the pass through to the receiver', () => {
    const sim = setup();
    sim.pass(3, 0, -1);
    expect(sim.ball.passTarget).toBe(5);
    expect(untilTaken(sim, () => place(sim, 6, 0, -10))).toBe(5);
  });

  it('an opponent on the line cuts out a ground pass', () => {
    const sim = setup();
    sim.pass(3, 0, -1);
    expect(untilTaken(sim, () => place(sim, T + 2, 0, -10))).toBe(T + 2);
  });

  it('a long ball lands and still reaches a receiver on the move', () => {
    const sim = setup();
    sim.pass(3, -1, 0, -1, true);
    const target = sim.ball.passTarget;
    expect(untilTaken(sim, () => Object.assign(sim.players[target], { vx: 0, vy: 8 }))).toBe(target);
  });
});

/** Waits for the kickoff whistle, then taps PASS to start play. */
function kickOff(sim: MatchSim) {
  for (let i = 0; i < 62; i++) sim.step(new Map([[0, NO_INPUT]]));
  sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
  sim.step(new Map([[0, NO_INPUT]]));
}

describe('kickoff', () => {
  it('nobody moves until the taker passes to a teammate', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    for (let i = 0; i < 120; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 1, my: 0 }]]));
    expect(sim.state).toBe('kickoff');
    expect(sim.ball.owner).toBe(5);
    expect(sim.players[5].x).toBeCloseTo(0, 5);
    const clock = sim.clock;
    sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.state).toBe('play');
    expect(sim.ball.passTarget).toBe(4); // the partner beside the taker
    expect(sim.clock).toBe(clock);
  });

  it('the computer kicks off with a pass, and an idle human gets theirs taken for them', () => {
    const cpu = new MatchSim(cfg);
    let passed = false;
    for (let i = 0; i < 120 && !passed; i++) passed = cpu.step().some((e) => e.type === 'pass');
    expect(passed).toBe(true);
    expect(cpu.state).toBe('play');

    const idle = new MatchSim(cfg);
    idle.addHuman(0, 0, 'you');
    for (let i = 0; i < 60 * 7; i++) idle.step(new Map([[0, NO_INPUT]]));
    expect(idle.state).toBe('play');
  });
});

describe('human control', () => {
  it('the ball slows you a little, walking or sprinting; a sprint is always quicker', () => {
    const speedAfter = (withBall: boolean, mx: number) => {
      const sim = new MatchSim(cfg);
      sim.addHuman(0, 0, 'you');
      place(sim, 3, 0, -10);
      if (withBall) giveBall(sim, 3);
      else {
        // An opponent far away has it.
        place(sim, T + 3, 15, 25);
        giveBall(sim, T + 3);
        Object.assign(sim.ball, { x: 15, y: 24 });
      }
      Object.assign(sim.humans.get(0)!, { controlled: 3, lockSwitch: 10 });
      sim.players[3].human = 0;
      for (let t = 0; t < 40; t++) sim.step(new Map([[0, { ...NO_INPUT, mx }]]));
      return Math.hypot(sim.players[3].vx, sim.players[3].vy);
    };
    const walk = speedAfter(false, 0.9);
    const dribble = speedAfter(true, 0.9);
    const sprint = speedAfter(false, 1);
    const dribbleSprint = speedAfter(true, 1);
    expect(walk).toBeGreaterThan(7);
    expect(dribble).toBeLessThan(walk);
    expect(dribble).toBeGreaterThan(6);
    expect(dribbleSprint).toBeLessThan(sprint);
    expect(sprint).toBeGreaterThan(walk);
    expect(dribbleSprint).toBeGreaterThan(dribble);
  });

  it('controls the ball carrier and follows passes (PASS fires on release)', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    const striker = 5;
    expect(sim.humans.get(0)!.controlled).toBe(striker); // kickoff taker
    for (let i = 0; i < 70; i++) sim.step(new Map([[0, NO_INPUT]]));
    const press = (inp: Partial<Input>) => sim.step(new Map([[0, { ...NO_INPUT, ...inp }]]));
    press({ pass: true });
    expect(sim.ball.owner).toBe(striker);
    press({});
    const target = sim.ball.passTarget;
    expect(target).toBeGreaterThan(0);
    expect(sim.humans.get(0)!.controlled).toBe(target);
  });

  it('PASS must charge to full for a long ball; released early it is a ground pass', () => {
    const passAfter = (ticks: number) => {
      const sim = new MatchSim(cfg);
      sim.addHuman(0, 0, 'you');
      kickOff(sim);
      const me = sim.humans.get(0)!.controlled;
      giveBall(sim, me);
      for (let t = 0; t < ticks; t++) sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
      const charge = sim.passChargeOf(me);
      sim.step(new Map([[0, NO_INPUT]]));
      expect(sim.ball.owner).not.toBe(me);
      return { charge, lofted: sim.ball.flying };
    };
    const half = passAfter(30);
    expect(half.charge).toBeGreaterThan(0.3);
    expect(half.charge).toBeLessThan(1);
    expect(half.lofted).toBe(false);
    const full = passAfter(Math.ceil(PASS_CHARGE_TIME * 60) + 2);
    expect(full.charge).toBe(1);
    expect(full.lofted).toBe(true);
  });

  it('a sprint steers with the stick, turning wider than a walk', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    kickOff(sim);
    for (let i = 0; i < 40; i++) sim.step(new Map([[0, NO_INPUT]]));
    giveBall(sim, sim.humans.get(0)!.controlled);
    const me = sim.players[sim.humans.get(0)!.controlled];
    for (let i = 0; i < 20; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 1, my: 0 }]]));
    expect(me.sprinting).toBe(true);
    // Swinging the stick round the edge turns the sprint without slowing to a walk, but not at once.
    for (let i = 0; i < 6; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 0, my: 1 }]]));
    expect(me.fy).toBeLessThan(0.6);
    for (let i = 0; i < 45; i++) sim.step(new Map([[0, { ...NO_INPUT, mx: 0, my: 1 }]]));
    expect(me.sprinting).toBe(true);
    expect(me.fy).toBeCloseTo(1, 5);
    expect(me.vy).toBeGreaterThan(8);
    expect(Math.abs(me.vx)).toBeLessThan(1);
  });
});

describe('defending', () => {
  /** Team 1 (computer) has the ball; my team 0 is spread out. */
  function defend() {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'you');
    kickOff(sim);
    place(sim, 1, -12, -20);
    place(sim, 2, 12, -20);
    place(sim, 3, -4, -8);
    place(sim, 4, 4, 6); // nearest the ball, behind the carrier
    place(sim, 5, 0, 14);
    place(sim, 6, -10, -14);
    place(sim, T + 3, 4, 0);
    giveBall(sim, T + 3);
    sim.players[T + 3].protect = 0;
    sim.assignControl(true);
    return sim;
  }

  it('touching the ball carrier wins the ball', () => {
    const sim = defend();
    // A second (idle) human carries the ball, so it isn't passed away the moment I arrive.
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    expect(me).toBe(4);
    place(sim, me, 4, -1.0);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
  });

  it('a touch you can see wins it: the drawn discs just meeting is enough', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    // 1.5 m apart: the 0.78 m discs on screen overlap, the 0.6 m bodies don't quite.
    place(sim, me, 4, -1.5);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
  });

  it('after a steal the loser just stops (no shove) and I dribble away from them', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    const them = T + 3;
    place(sim, me, 4, -1.0);
    sim.players[them].vy = -5; // running at me
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
    expect(Math.hypot(sim.players[them].vx, sim.players[them].vy)).toBeLessThan(0.5);
    // I run off, they chase me: still mine, and I get away.
    const dist = () => Math.hypot(sim.players[me].x - sim.players[them].x, sim.players[me].y - sim.players[them].y);
    const before = dist();
    for (let t = 0; t < 20; t++) {
      sim.step(
        new Map([
          [0, { ...NO_INPUT, mx: 0, my: -0.9 }],
          [1, { ...NO_INPUT, mx: 0, my: -0.9 }],
        ]),
      );
      expect(sim.ball.owner).toBe(me);
    }
    expect(dist()).toBeGreaterThan(before + 1);
    // Once the moment is over, touching me takes it back again (their teammates stay out of it).
    for (let t = 0; t < 60; t++) {
      for (let j = T + 1; j < 2 * T; j++) if (j !== them) place(sim, j, -18, 28 - (j - T) * 3);
      sim.step(new Map([[0, NO_INPUT]]));
    }
    place(sim, them, sim.players[me].x, sim.players[me].y - 1.25);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(them);
  });

  it('I take the ball and run straight on through them: it never sticks between us', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    const them = T + 3;
    place(sim, me, 4, -1.0);
    sim.step(new Map([[0, { ...NO_INPUT, my: 0.9 }]]));
    expect(sim.ball.owner).toBe(me);
    for (let t = 0; t < 30; t++) {
      sim.step(new Map([[0, { ...NO_INPUT, my: 0.9 }]]));
      expect(sim.ball.owner).toBe(me);
    }
    // Out the other side, the ball in front of me.
    expect(sim.players[me].y).toBeGreaterThan(sim.players[them].y + 1.5);
    expect(sim.ball.y).toBeGreaterThan(sim.players[me].y);
  });

  it('the loser can not win it back while still leaning on me, only after stepping away', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    const them = T + 3;
    place(sim, me, 4, -1.0);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
    // Two seconds glued to me (long past every guard): still my ball. Their teammates stay out of it.
    for (let t = 0; t < 120; t++) {
      place(sim, them, sim.players[me].x, sim.players[me].y - 1.25);
      for (let j = T + 1; j < 2 * T; j++) if (j !== them) place(sim, j, -18, 28 - (j - T) * 3);
      sim.step(new Map([[0, NO_INPUT]]));
      expect(sim.ball.owner).toBe(me);
    }
    // They step off, then come in again: now the touch wins it.
    place(sim, them, sim.players[me].x, sim.players[me].y - 4);
    sim.step(new Map([[0, NO_INPUT]]));
    place(sim, them, sim.players[me].x, sim.players[me].y - 1.25);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(them);
  });

  it('picking up a loose ball also gives half a second to get away, then a touch wins it', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    // The ball runs loose at their feet; I'm right there too.
    Object.assign(sim.ball, { owner: -1, x: 4, y: 0, vx: 0, vy: 0, lastTouch: me });
    place(sim, me, 4, -1.0);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(T + 3);
    let t = 0;
    while (sim.ball.owner !== me && t++ < 60) sim.step(new Map([[0, NO_INPUT]]));
    expect(t).toBeGreaterThanOrEqual(28);
    expect(t).toBeLessThanOrEqual(32);
  });

  it('the loser of a tackle can not intercept the pass the winner plays straight away', () => {
    const sim = defend();
    sim.addHuman(1, 1, 'them');
    const me = sim.humans.get(0)!.controlled;
    const them = T + 3;
    place(sim, me, 4, -1.0);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
    // I pass at once, right through where they stand.
    place(sim, 5, 4, 14);
    sim.pass(me, 0, 1, 5);
    for (let t = 0; t < 20 && sim.ball.owner < 0; t++) {
      place(sim, them, sim.ball.x, sim.ball.y);
      sim.step(new Map([[0, NO_INPUT]]));
    }
    expect(sim.ball.owner).not.toBe(them);
  });

  it('tap PASS: switch to the player nearest the ball (the next one if that is me)', () => {
    const sim = defend();
    sim.players[T + 3].protect = 100; // nobody wins the ball during this test
    const h = sim.humans.get(0)!;
    expect(h.controlled).toBe(4);
    const tap = () => {
      sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
      sim.step(new Map([[0, NO_INPUT]]));
    };
    tap();
    expect(h.controlled).toBe(3);
    // Control stays where I put it for a moment instead of snapping back.
    for (let t = 0; t < 30; t++) sim.step(new Map([[0, NO_INPUT]]));
    expect(h.controlled).toBe(3);
    // Tapping again goes back to the nearest.
    tap();
    expect(h.controlled).toBe(4);
  });

  it('hold PASS: my player sprints at the ball', () => {
    const sim = defend();
    sim.players[T + 3].protect = 100;
    const h = sim.humans.get(0)!;
    for (let t = 0; t < 30; t++) sim.step(new Map([[0, { ...NO_INPUT, pass: true }]]));
    // Holding doesn't switch: the same player chases.
    expect(h.controlled).toBe(4);
    const me = sim.players[4];
    const b = sim.ball;
    const d = Math.hypot(b.x - me.x, b.y - me.y);
    const sp = Math.hypot(me.vx, me.vy);
    expect(me.sprinting).toBe(true);
    expect(sp).toBeGreaterThan(7);
    expect(((b.x - me.x) * me.vx + (b.y - me.y) * me.vy) / (d * sp)).toBeGreaterThan(0.8);
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
    // Harder shots reach the goal sooner and leave the keeper less time: a full charge about twice as fast.
    expect(full.duel!.ticks).toBeLessThan(tap.duel!.ticks);
    expect(tap.duel!.ticks).toBeGreaterThan(full.duel!.ticks * 1.6);
    const half = ready();
    hold(half, 30, {});
    expect(half.duel!.ticks).toBeLessThan(tap.duel!.ticks);
    expect(half.duel!.ticks).toBeGreaterThan(full.duel!.ticks);
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

  it('SHOOT while my pass is on its way: the receiver strikes it first time, before controlling it', () => {
    const sim = ready();
    const me = sim.humans.get(0)!.controlled;
    const mate = [1, 2, 3, 4, 5, 6].find((j) => j !== me)!;
    place(sim, mate, 2, 18);
    sim.pass(me, 0, 0, mate);
    // Tap SHOOT straight after passing: control jumps to the receiver and the shot waits for the ball.
    sim.step(new Map([[0, { ...NO_INPUT, shoot: true }]]));
    expect(sim.humans.get(0)!.controlled).toBe(mate);
    sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.state).toBe('play');
    let t = 0;
    while (sim.state === 'play' && t++ < 120) sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.state).toBe('duel');
    expect(sim.duel!.shooter).toBe(mate);
    // Struck before the receiver could have picked the pass up.
    expect(Math.hypot(sim.duel!.sx - sim.players[mate].x, sim.duel!.sy - sim.players[mate].y)).toBeGreaterThan(1.15);
  });
});

describe('off the ball: roles and tactics', () => {
  /** I stand on the ball in midfield (nobody can take it); my teammates take up the tactic's shape. */
  function settle(tactic: Tactic, ticks = 200) {
    const sim = new MatchSim({ ...cfg, seed: 11 });
    sim.addHuman(0, 0, 'you');
    sim.setTactic(0, tactic);
    sim.state = 'play';
    const me = 6;
    place(sim, me, -2, -4);
    giveBall(sim, me);
    sim.players[me].protect = 99;
    sim.assignControl(true);
    for (let t = 0; t < ticks; t++) sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.ball.owner).toBe(me);
    const mates = [1, 2, 3, 4, 5].map((r) => sim.players[r]);
    return { sim, me: sim.players[me], mates };
  }

  it('spread out over the pitch: nobody on top of anyone, nobody hugging a line, width on both sides', () => {
    for (const t of TACTIC_IDS) {
      const { me, mates } = settle(t);
      const all = [me, ...mates];
      for (let a = 0; a < all.length; a++)
        for (let b = a + 1; b < all.length; b++) expect(Math.hypot(all[a].x - all[b].x, all[a].y - all[b].y)).toBeGreaterThan(4);
      for (const p of mates) {
        expect(Math.abs(p.x)).toBeLessThan(HALF_W - 2);
        expect(Math.abs(p.y)).toBeLessThan(HALF_L - 3);
      }
      expect(mates.some((p) => p.x < -7)).toBe(true);
      expect(mates.some((p) => p.x > 7)).toBe(true);
    }
  });

  it('each number plays its role: 2 and 3 stay behind the ball on their own sides, 7 leads the line', () => {
    for (const t of TACTIC_IDS) {
      const { sim, me } = settle(t);
      const [lb, rb, lw, rw, st] = [1, 2, 3, 4, 5].map((r) => sim.players[r]);
      expect(lb.y).toBeLessThan(me.y);
      expect(rb.y).toBeLessThan(me.y);
      expect(lb.x).toBeLessThan(rb.x);
      expect(lw.x).toBeLessThan(rw.x);
      // The 7 is ahead of the ball and of the 4 (me) and both defenders (a winger may be past him on a run).
      expect(st.y).toBeGreaterThan(me.y + 4);
      expect(st.y).toBeGreaterThan(Math.max(lb.y, rb.y) + 8);
    }
  });

  it('possession comes close to show for the ball; direct stretches the defence', () => {
    const spread = (t: Tactic) => {
      const { me, mates } = settle(t);
      return {
        near: mates.reduce((s, p) => s + Math.hypot(p.x - me.x, p.y - me.y), 0) / mates.length,
        top: Math.max(...mates.map((p) => p.y)),
      };
    };
    const pos = spread('possession');
    const bal = spread('balanced');
    const dir = spread('direct');
    expect(pos.near).toBeLessThan(bal.near);
    expect(bal.near).toBeLessThan(dir.near);
    expect(pos.top).toBeLessThan(dir.top);
  });

  it('direct: forwards time runs in behind the defence when the man on the ball is free', () => {
    const { sim } = settle('direct', 1);
    let ran = false;
    for (let t = 0; t < 360 && !ran; t++) {
      sim.step(new Map([[0, NO_INPUT]]));
      ran = [3, 4, 5].some((r) => sim.brain[r].run > 0);
    }
    expect(ran).toBe(true);
  });

  it('picking a tactic mid-match takes effect at once', () => {
    const { sim, me, mates } = settle('possession');
    const spread = () => mates.reduce((s, p) => s + Math.hypot(p.x - me.x, p.y - me.y), 0) / mates.length;
    const before = spread();
    sim.setTactic(0, 'direct');
    for (let t = 0; t < 120; t++) sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.tactic[0]).toBe('direct');
    expect(spread()).toBeGreaterThan(before + 2);
  });

  it('defending: the runner nearest our goal is marked goal-side', () => {
    const sim = new MatchSim({ ...cfg, seed: 5 });
    sim.addHuman(1, 1, 'them');
    sim.state = 'play';
    // They hold the ball in midfield (a human standing on it), their striker waits on the edge of our box.
    const carrier = T + 6;
    place(sim, carrier, 0, 2);
    giveBall(sim, carrier);
    sim.players[carrier].protect = 99;
    sim.assignControl(true);
    for (let t = 0; t < 150; t++) {
      Object.assign(sim.players[T + 5], { x: 3, y: -20, vx: 0, vy: 0 });
      sim.step(new Map([[1, NO_INPUT]]));
    }
    expect(sim.ball.owner).toBe(carrier);
    const a = sim.players[T + 5];
    const markers = [1, 2, 3, 4, 6].map((r) => sim.players[r]).filter((p) => Math.hypot(p.x - a.x, p.y - a.y) < 3.5);
    expect(markers.some((p) => p.y < a.y)).toBe(true);
  });

  it('a computer team chases the game when behind late on, and keeps the ball when ahead', () => {
    const sim = new MatchSim({ ...cfg, seed: 2 });
    sim.addHuman(0, 0, 'you');
    sim.state = 'play';
    sim.clock = 50;
    sim.score[0] = 1;
    for (let t = 0; t < 61; t++) sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.tactic[1]).toBe('direct');
    sim.score[1] = 2;
    for (let t = 0; t < 61; t++) sim.step(new Map([[0, NO_INPUT]]));
    expect(sim.tactic[1]).toBe('possession');
  });
});

describe('keeper with the ball', () => {
  it('a caught ball is safe: an opponent on top of the keeper can not take it or cut out the throw', () => {
    const sim = new MatchSim(cfg);
    sim.state = 'play';
    const keeper = 0;
    place(sim, keeper, 0, -HALF_L + 1.4);
    Object.assign(sim.ball, { owner: keeper, lastTouch: keeper, passTarget: -1 });
    sim.keeperHold = 0;
    for (let t = 0; t < 90; t++) {
      place(sim, T + 5, sim.players[keeper].x + 0.5, sim.players[keeper].y + 0.5);
      sim.step();
      if (sim.ball.owner === keeper) continue;
      // Released: the throw goes over the opponent standing in front.
      expect(sim.ball.owner).toBe(-1);
      expect(sim.ball.flying).toBe(true);
      break;
    }
    expect(sim.ball.owner).not.toBe(T + 5);
    expect(sim.ball.passTarget).toBeGreaterThan(0);
  });
});

describe('human keeper dives with the stick', () => {
  it('when time runs out, the keeper dives where the stick points', () => {
    const sim = new MatchSim(cfg);
    sim.addHuman(0, 0, 'keeper side');
    sim.state = 'play';
    // Opponent shoots at team 0's goal.
    const shooter = T + 5;
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
        expect(Math.abs(sim.ball.x)).toBeLessThanOrEqual(HALF_W + 0.01);
        expect(Math.abs(sim.ball.y)).toBeLessThanOrEqual(HALF_L + 0.01);
      }
      expect(sim.state).toBe('ended');
    }
    expect(passes).toBeGreaterThan(200);
    expect(shots).toBeGreaterThan(3);
    expect(goals).toBeGreaterThan(1);
  });
});
