import { describe, expect, it } from 'vitest';
import { NO_INPUT } from '../../src/match/types';
import { decodeSnapshot, encodeSnapshot, viewFromSim } from '../../src/match/view';
import { MatchSim } from '../../src/match/sim';
import { LanClient } from '../../src/net/client';
import { LanHost } from '../../src/net/host';
import { loopbackBackend } from '../../src/net/loopback';
import { decodeInput, decodeSnapFloats, encodeInput, encodeSnap } from '../../src/net/protocol';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('protocol', () => {
  it('round-trips inputs, keeping a full push at the edge', () => {
    const i = decodeInput(encodeInput({ mx: 0.6, my: 0.8, pass: true, shoot: false, dive: 4 }));
    expect(Math.hypot(i.mx, i.my)).toBeGreaterThanOrEqual(0.999);
    expect(i.pass).toBe(true);
    expect(i.shoot).toBe(false);
    expect(i.dive).toBe(4);
    expect(decodeInput(encodeInput(NO_INPUT)).dive).toBe(-1);
  });

  it('round-trips snapshots with events', () => {
    const sim = new MatchSim({ duration: 60, difficulty: 1, seed: 1 });
    for (let k = 0; k < 200; k++) sim.step();
    const v = viewFromSim(sim);
    const bytes = encodeSnap(encodeSnapshot(v, [{ type: 'goal', team: 1, by: 9 }]));
    // Simulate an unaligned network buffer.
    const shifted = new Uint8Array(bytes.length + 1).subarray(1);
    shifted.set(bytes);
    const { view, events } = decodeSnapshot(decodeSnapFloats(shifted));
    expect(view.players).toHaveLength(12);
    expect(view.players[7].x).toBeCloseTo(v.players[7].x, 4);
    expect(view.state).toBe(v.state);
    expect(view.ball.owner).toBe(v.ball.owner);
    expect(events).toEqual([{ type: 'goal', team: 1, by: 9 }]);
  });
});

describe('host + clients over a network', () => {
  it('discovers, joins, picks teams, starts and plays', async () => {
    const net = loopbackBackend();
    const host = new LanHost(net.host(), 'Atta');
    await host.open();

    const c1 = new LanClient(net.client(), 'Sam');
    const c2 = new LanClient(net.client(), 'Lea');
    let found: { id: string; name: string; address: string }[] = [];

    const transport = net.client();
    const games = await new Promise<{ id: string; name: string; address: string }[]>((res) => {
      void transport.discover((g) => res(g)).then((s) => s);
    });
    expect(games.map((g) => g.name)).toContain('Atta');
    found = games;

    await c1.join(found[0]);
    await c2.join(found[0]);
    await flush();
    await flush();
    expect(host.players.map((p) => p.name)).toEqual(['Atta', 'Sam', 'Lea']);
    // Auto-balanced: host on blue, first joiner on red, next on blue.
    expect(host.players.map((p) => p.team)).toEqual([0, 1, 0]);
    expect(c1.mySlot).toBe(1);
    expect(c2.players).toHaveLength(3);

    c2.setTeam(1);
    await flush();
    await flush();
    expect(host.players.find((p) => p.name === 'Lea')!.team).toBe(1);

    let started = 0;
    c1.onStart = () => started++;
    host.start(60);
    await flush();
    await flush();
    expect(started).toBe(1);

    // Run ~2 seconds: host simulates, clients send inputs and receive snapshots.
    for (let f = 0; f < 120; f++) {
      host.update(1 / 60, NO_INPUT);
      c1.update(1 / 60, { ...NO_INPUT, mx: 0.8, my: 0 });
      c2.update(1 / 60, NO_INPUT);
      await flush();
    }
    const v1 = c1.update(0, NO_INPUT).view;
    expect(v1).not.toBeNull();
    expect(v1!.players).toHaveLength(12);
    const sim = host.sim!;
    expect(sim.humans.size).toBe(3);
    // Sam's controlled player is moving in +x (his input) after kickoff.
    const sam = sim.players[sim.humans.get(1)!.controlled];
    expect(sam.team).toBe(1);
    expect(sam.vx).toBeGreaterThan(2);

    // A client leaving hands their player back to the computer.
    c2.close();
    await flush();
    await flush();
    expect(sim.humans.size).toBe(2);
    expect(host.players).toHaveLength(2);

    // Host leaving tells clients.
    let bye = '';
    c1.onBye = (r) => (bye = r);
    host.close();
    await flush();
    await flush();
    expect(bye).toBeTruthy();
  });
});
