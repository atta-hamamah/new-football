// A joining phone: sends its input, receives snapshots and draws them slightly in the
// past, blending between the two snapshots around that moment for smooth movement.

import type { Session } from '../match/session';
import { type Input, type MatchEvent, type Team } from '../match/types';
import { decodeSnapshot, interpolate, type ViewState } from '../match/view';
import {
  type ByeMsg,
  decodeJson,
  decodeSnapFloats,
  encodeInput,
  encodeJson,
  type HelloMsg,
  type LobbyMsg,
  type LobbyPlayer,
  Msg,
  msgType,
  PROTOCOL_VERSION,
  type StartMsg,
  type WelcomeMsg,
} from './protocol';
import type { ClientTransport, GameInfo } from './transport';

/** How far behind real time we draw, so there is always a newer snapshot to blend towards. */
const RENDER_DELAY = 0.075;

interface Buffered {
  t: number;
  view: ViewState;
}

export class LanClient implements Session {
  mySlot = -1;
  readonly canRestart = false;
  readonly names = new Map<number, string>();
  players: LobbyPlayer[] = [];
  hostName = '';
  started = false;
  lost?: string;
  onLobby?: (players: LobbyPlayer[]) => void;
  onStart?: () => void;
  onBye?: (reason: string) => void;
  private buffer: Buffered[] = [];
  private pendingEvents: MatchEvent[] = [];
  private clock = 0;
  private lastSent = '';
  private sinceSend = 0;

  constructor(
    private readonly transport: ClientTransport,
    readonly name: string,
  ) {
    transport.onData = (d) => this.onData(d);
    transport.onClose = (reason) => {
      this.lost = reason;
      this.onBye?.(reason);
    };
  }

  get myTeam(): Team {
    return this.players.find((p) => p.slot === this.mySlot)?.team ?? 0;
  }

  async join(game: GameInfo): Promise<void> {
    await this.transport.connect(game);
    this.transport.send(encodeJson(Msg.Hello, { name: this.name, version: PROTOCOL_VERSION } satisfies HelloMsg));
  }

  setTeam(team: Team): void {
    this.transport.send(encodeJson(Msg.Team, { team }));
  }

  private onData(d: Uint8Array): void {
    switch (msgType(d)) {
      case Msg.Welcome:
        this.mySlot = decodeJson<WelcomeMsg>(d).slot;
        break;
      case Msg.Lobby: {
        const m = decodeJson<LobbyMsg>(d);
        this.players = m.players;
        this.hostName = m.hostName;
        for (const p of m.players) this.names.set(p.slot, p.name);
        this.onLobby?.(m.players);
        break;
      }
      case Msg.Start: {
        const m = decodeJson<StartMsg>(d);
        this.players = m.players;
        for (const p of m.players) this.names.set(p.slot, p.name);
        this.buffer = [];
        const first = !this.started;
        this.started = true;
        if (first) this.onStart?.();
        break;
      }
      case Msg.Snap: {
        const { view, events } = decodeSnapshot(decodeSnapFloats(d));
        // Drop out-of-order snapshots.
        const last = this.buffer[this.buffer.length - 1];
        if (last && view.tick <= last.view.tick) {
          if (view.tick < last.view.tick - 120)
            this.buffer = []; // match restarted
          else return;
        }
        this.buffer.push({ t: this.clock, view });
        if (this.buffer.length > 30) this.buffer.shift();
        this.pendingEvents.push(...events);
        break;
      }
      case Msg.Bye:
        this.lost = decodeJson<ByeMsg>(d).reason;
        this.onBye?.(this.lost);
        break;
      default:
        break;
    }
  }

  update(dt: number, input: Input): { view: ViewState | null; events: MatchEvent[] } {
    this.clock += dt;
    // Inputs: send at most 60/s, and immediately when they change.
    this.sinceSend += dt;
    const key = `${input.mx.toFixed(2)},${input.my.toFixed(2)},${input.pass},${input.shoot},${input.dive}`;
    if (key !== this.lastSent || this.sinceSend > 0.1) {
      if (this.sinceSend >= 1 / 60 || key !== this.lastSent) {
        this.transport.send(encodeInput(input));
        this.lastSent = key;
        this.sinceSend = 0;
      }
    }

    const events = this.pendingEvents;
    this.pendingEvents = [];
    const buf = this.buffer;
    if (!buf.length) return { view: null, events };
    const rt = this.clock - RENDER_DELAY;
    let view = buf[buf.length - 1].view;
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.t <= rt && rt <= b.t) {
        view = interpolate(a.view, b.view, (rt - a.t) / (b.t - a.t || 1));
        break;
      }
    }
    return { view, events };
  }

  restart(): void {}

  close(): void {
    this.transport.close();
  }
}
