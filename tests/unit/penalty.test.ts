import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { KEEPERS, keeperGuess, makeTell } from '../../src/duel/ai';
import { swayAmplitude } from '../../src/duel/aim';
import { zoneCenter, ZONES } from '../../src/duel/goal';
import { resolveShot } from '../../src/duel/resolve';
import { botRun } from '../../src/run/bots';
import { prepareShot, takeShot } from '../../src/run/kick';
import { Run, STAGES } from '../../src/run/run';
import { Shootout } from '../../src/run/shootout';
import { rollOffers, UPGRADES } from '../../src/run/upgrades';

describe('resolveShot', () => {
  const dive = { target: zoneCenter(ZONES[2]), reach: 1.2, adjust: 0 }; // bottom right
  it('saves a shot near where the keeper dives', () => {
    expect(resolveShot({ x: 2.2, y: 0.4, speed: 25 }, dive).outcome).toBe('saved');
  });
  it('concedes when the keeper goes the wrong way', () => {
    expect(resolveShot({ x: -2.8, y: 0.4, speed: 25 }, dive).outcome).toBe('goal');
  });
  it('beats a correct guess with a shot right into the top corner', () => {
    expect(resolveShot({ x: 3.4, y: 2.2, speed: 25 }, dive).outcome).toBe('goal');
  });
  it('detects wide, over and the frame', () => {
    expect(resolveShot({ x: 4.2, y: 1, speed: 25 }, dive).outcome).toBe('wide');
    expect(resolveShot({ x: 0, y: 2.9, speed: 25 }, dive).outcome).toBe('over');
    expect(resolveShot({ x: -3.6, y: 1, speed: 25 }, dive).outcome).toBe('post');
    expect(resolveShot({ x: -3.6, y: 1, speed: 25 }, dive, { postIn: true }).outcome).toBe('goal');
  });
  it('faster shots are harder to save', () => {
    const slow = resolveShot({ x: 3.1, y: 1, speed: 18 }, dive);
    const fast = resolveShot({ x: 3.1, y: 1, speed: 32 }, dive);
    expect(fast.margin).toBeGreaterThan(slow.margin);
  });
});

describe('shootout rules', () => {
  it('alternates, starting with you', () => {
    const so = new Shootout();
    expect(so.next).toBe('you');
    so.record('you', true);
    expect(so.next).toBe('them');
    expect(() => so.record('you', true)).toThrow();
  });

  it('ends early when one side cannot catch up', () => {
    const so = new Shootout();
    for (let i = 0; i < 3; i++) {
      so.record('you', true);
      so.record('them', false);
    }
    // 3-0 with two kicks each left: them can reach at most 2.
    expect(so.winner).toBe('you');
    expect(so.next).toBeNull();
  });

  it('goes to sudden death after 5-5', () => {
    const so = new Shootout();
    for (let i = 0; i < 5; i++) {
      so.record('you', true);
      so.record('them', true);
    }
    expect(so.winner).toBeNull();
    expect(so.suddenDeath).toBe(true);
    so.record('you', false);
    expect(so.winner).toBeNull(); // they still have to kick
    so.record('them', true);
    expect(so.winner).toBe('them');
  });
});

describe('keeper AI', () => {
  it('a learning keeper dives where you keep shooting', () => {
    const rng = new Rng(1);
    const history = [0, 0, 20, 0, 0, 0]; // always bottom right
    let right = 0;
    for (let i = 0; i < 500; i++) if (keeperGuess(KEEPERS.analyst, history, rng) === 2) right++;
    expect(right / 500).toBeGreaterThan(0.5);
  });

  it('an honest tell points the right way most of the time', () => {
    const rng = new Rng(2);
    let ok = 0;
    for (let i = 0; i < 1000; i++) if (makeTell(1, 0.8, rng).col === 1) ok++;
    expect(ok / 1000).toBeGreaterThan(0.75);
    expect(ok / 1000).toBeLessThan(0.85);
  });
});

describe('aim wobble', () => {
  it('is bigger in the corners than in the middle', () => {
    expect(swayAmplitude({ x: 3.3, y: 2.2 }, 1, 1)).toBeGreaterThan(swayAmplitude({ x: 0, y: 1 }, 1, 1) * 3);
  });
});

describe('run', () => {
  it('is reproducible from a seed (daily runs are the same for everyone)', () => {
    const a = new Run(42);
    const b = new Run(42);
    expect(b.opponent).toEqual(a.opponent);
    const pa = prepareShot(a);
    const pb = prepareShot(b);
    expect(pb).toEqual(pa);
    expect(takeShot(b, pb, { x: 2, y: 1 })).toEqual(takeShot(a, pa, { x: 2, y: 1 }));
  });

  it('daily seed depends only on the date', () => {
    expect(Run.daily(new Date('2026-10-09T08:00:00Z')).seed).toBe(Run.daily(new Date('2026-10-09T20:00:00Z')).seed);
    expect(Run.daily(new Date('2026-10-10T08:00:00Z')).seed).not.toBe(Run.daily(new Date('2026-10-09T08:00:00Z')).seed);
  });

  it('has bosses in the middle and at the end', () => {
    expect(STAGES.filter((s) => s.boss)).toHaveLength(2);
    expect(STAGES[STAGES.length - 1].boss).toBe(true);
  });

  it('offers 3 distinct upgrades and never a unique one twice', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const offers = rollOffers(rng, ['postin', 'scout', 'streak']);
      expect(new Set(offers.map((o) => o.id)).size).toBe(3);
      expect(offers.some((o) => ['postin', 'scout', 'streak'].includes(o.id))).toBe(false);
    }
    expect(UPGRADES.length).toBeGreaterThanOrEqual(12);
  });

  it('a won match offers upgrades, picking one advances to the next stage', () => {
    const run = new Run(5);
    run.finishMatch(true);
    expect(run.pendingOffers).toHaveLength(3);
    const first = run.opponent;
    run.pickUpgrade(run.pendingOffers![0].id);
    expect(run.stage).toBe(1);
    expect(run.opponent).not.toBe(first);
  });

  it('a spare life lets you survive one lost match', () => {
    const run = new Run(6);
    run.stats.lives = 1;
    run.finishMatch(false);
    expect(run.status).toBe('playing');
    run.finishMatch(false);
    expect(run.status).toBe('over');
  });
});

describe('balance (simulated players)', () => {
  it('better players go further', () => {
    const avg = (skill: 'random' | 'casual' | 'smart') => {
      let w = 0;
      for (let i = 0; i < 150; i++) w += botRun(500 + i, skill).wins;
      return w / 150;
    };
    const random = avg('random');
    const casual = avg('casual');
    const smart = avg('smart');
    expect(random).toBeLessThan(casual);
    expect(casual).toBeLessThan(smart);
    // Random play should not get far; good play should usually reach the second half.
    expect(random).toBeLessThan(2);
    expect(smart).toBeGreaterThan(4);
  });
});
