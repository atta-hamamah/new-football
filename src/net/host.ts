// The host phone: runs the lobby, then the authoritative match. Every client only sends
// inputs; the host simulates and broadcasts snapshots 30 times a second.

import type { Session } from '../match/session';
import { SimRunner } from '../match/session';
import { MatchSim } from '../match/sim';
import { type Input, type MatchEvent, NO_INPUT, type Team } from '../match/types';
import { encodeSnapshot, type ViewState, viewFromSim } from '../match/view';
import {
  type ByeMsg,
  decodeInput,
  decodeJson,
  encodeJson,
  encodeSnap,
  type HelloMsg,
  type LobbyMsg,
  type LobbyPlayer,
  Msg,
  msgType,
  PROTOCOL_VERSION,
  type StartMsg,
  type TeamMsg,
} from './protocol';
import type { HostTransport } from './transport';

export const MAX_PLAYERS = 12;
const SNAP_EVERY = 2; // ticks (60 Hz / 2 = 30 snapshots per second)

export class LanHost implements Session {
  readonly mySlot = 0;
  readonly canRestart = true;
  readonly names = new Map<number, string>();
  players: LobbyPlayer[] = [];
  started = false;
  duration = 180;
  onLobby?: (players: LobbyPlayer[]) => void;
  private readonly peerSlot = new Map<string, number>();
  private readonly inputs = new Map<number, Input>();
  private runner: SimRunner | null = null;
  private pendingEvents: MatchEvent[] = [];

  constructor(
    private readonly transport: HostTransport,
    readonly hostName: string,
  ) {
    this.players.push({ slot: 0, name: hostName, team: 0 });
    this.names.set(0, hostName);
    transport.onData = (peer, data) => this.onData(peer, data);
    transport.onLeave = (peer) => this.onLeave(peer);
  }

  get myTeam(): Team {
    return this.players.find((p) => p.slot === 0)?.team ?? 0;
  }

  async open(): Promise<void> {
    await this.transport.start(this.hostName);
  }

  private nextSlot(): number {
    for (let s = 1; s < MAX_PLAYERS; s++) if (!this.players.some((p) => p.slot === s)) return s;
    return -1;
  }

  private teamWithRoom(): Team {
    const c0 = this.players.filter((p) => p.team === 0).length;
    const c1 = this.players.filter((p) => p.team === 1).length;
    return c1 < c0 ? 1 : 0;
  }

  private onData(peer: string, data: Uint8Array): void {
    switch (msgType(data)) {
      case Msg.Hello: {
        const hello = decodeJson<HelloMsg>(data);
        if (hello.version !== PROTOCOL_VERSION) {
          this.transport.send(peer, encodeJson(Msg.Bye, { reason: 'Different game version. Update the app.' } satisfies ByeMsg));
          return;
        }
        if (this.started) {
          this.transport.send(peer, encodeJson(Msg.Bye, { reason: 'Match already started.' } satisfies ByeMsg));
          return;
        }
        const slot = this.nextSlot();
        if (slot < 0) {
          this.transport.send(peer, encodeJson(Msg.Bye, { reason: 'Game is full.' } satisfies ByeMsg));
          return;
        }
        const name = (hello.name || `Player ${slot + 1}`).slice(0, 14);
        this.peerSlot.set(peer, slot);
        this.players.push({ slot, name, team: this.teamWithRoom() });
        this.names.set(slot, name);
        this.transport.send(peer, encodeJson(Msg.Welcome, { slot }));
        this.broadcastLobby();
        break;
      }
      case Msg.Team: {
        const slot = this.peerSlot.get(peer);
        const p = this.players.find((x) => x.slot === slot);
        if (p && !this.started) {
          p.team = decodeJson<TeamMsg>(data).team === 1 ? 1 : 0;
          this.broadcastLobby();
        }
        break;
      }
      case Msg.Input: {
        const slot = this.peerSlot.get(peer);
        if (slot !== undefined) this.inputs.set(slot, decodeInput(data));
        break;
      }
      default:
        break;
    }
  }

  private onLeave(peer: string): void {
    const slot = this.peerSlot.get(peer);
    if (slot === undefined) return;
    this.peerSlot.delete(peer);
    this.players = this.players.filter((p) => p.slot !== slot);
    this.inputs.delete(slot);
    // Their player is handed back to the computer.
    this.runner?.sim.removeHuman(slot);
    this.broadcastLobby();
  }

  setTeam(slot: number, team: Team): void {
    const p = this.players.find((x) => x.slot === slot);
    if (!p || this.started) return;
    p.team = team;
    this.broadcastLobby();
  }

  broadcastLobby(): void {
    const msg: LobbyMsg = { players: this.players, hostName: this.hostName, started: this.started };
    this.transport.broadcast(encodeJson(Msg.Lobby, msg));
    this.onLobby?.(this.players);
  }

  start(duration = this.duration): void {
    this.duration = duration;
    this.started = true;
    const roster = [...this.players];
    this.runner = new SimRunner(() => {
      const sim = new MatchSim({ duration, difficulty: 1, seed: (Math.random() * 2 ** 32) >>> 0 });
      for (const p of roster) if (this.players.some((q) => q.slot === p.slot)) sim.addHuman(p.slot, p.team, p.name);
      return sim;
    });
    this.transport.broadcast(encodeJson(Msg.Start, { duration, players: roster } satisfies StartMsg));
    this.broadcastLobby();
  }

  // --- Session ----------------------------------------------------------------------------

  update(dt: number, input: Input): { view: ViewState | null; events: MatchEvent[] } {
    if (!this.runner) return { view: null, events: [] };
    const runner = this.runner;
    const events = runner.advance(
      dt,
      () => {
        const m = new Map(this.inputs);
        m.set(0, input);
        for (const p of this.players) if (!m.has(p.slot)) m.set(p.slot, NO_INPUT);
        return m;
      },
      (ev) => {
        this.pendingEvents.push(...ev);
        if (runner.sim.tick % SNAP_EVERY === 0) {
          this.transport.broadcast(encodeSnap(encodeSnapshot(viewFromSim(runner.sim), this.pendingEvents)));
          this.pendingEvents = [];
        }
      },
    );
    return { view: viewFromSim(runner.sim), events };
  }

  restart(): void {
    this.start(this.duration);
  }

  close(): void {
    this.transport.broadcast(encodeJson(Msg.Bye, { reason: 'The host left.' } satisfies ByeMsg));
    this.transport.stop();
  }

  /** For tests. */
  get sim(): MatchSim | null {
    return this.runner?.sim ?? null;
  }
}
