// In-memory "network" for tests and same-device debugging. Messages are delivered
// asynchronously (microtask) to behave like a real transport.

import type { ClientTransport, GameInfo, HostTransport, NetBackend } from './transport';

class Hub {
  hosts = new Map<string, LoopHost>();
  next = 1;
}

class LoopHost implements HostTransport {
  readonly id: string;
  name = '';
  readonly peers = new Map<string, LoopClient>();
  onPeer?: (peer: string) => void;
  onData?: (peer: string, data: Uint8Array) => void;
  onLeave?: (peer: string) => void;

  constructor(private readonly hub: Hub) {
    this.id = `h${hub.next++}`;
  }

  async start(name: string): Promise<void> {
    this.name = name;
    this.hub.hosts.set(this.id, this);
  }

  stop(): void {
    this.hub.hosts.delete(this.id);
    for (const c of this.peers.values()) c.closedByHost();
    this.peers.clear();
  }

  send(peer: string, data: Uint8Array): void {
    const c = this.peers.get(peer);
    const copy = data.slice();
    if (c) queueMicrotask(() => c.onData?.(copy));
  }

  broadcast(data: Uint8Array): void {
    for (const id of this.peers.keys()) this.send(id, data);
  }

  attach(c: LoopClient): string {
    const id = `p${this.hub.next++}`;
    this.peers.set(id, c);
    queueMicrotask(() => this.onPeer?.(id));
    return id;
  }

  detach(id: string): void {
    if (this.peers.delete(id)) queueMicrotask(() => this.onLeave?.(id));
  }
}

class LoopClient implements ClientTransport {
  private host: LoopHost | null = null;
  private peerId = '';
  onData?: (data: Uint8Array) => void;
  onClose?: (reason: string) => void;

  constructor(private readonly hub: Hub) {}

  async discover(onList: (games: GameInfo[]) => void): Promise<() => void> {
    const tick = () => onList([...this.hub.hosts.values()].map((h) => ({ id: h.id, name: h.name, address: h.id })));
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }

  async connect(game: GameInfo): Promise<void> {
    const h = this.hub.hosts.get(game.address);
    if (!h) throw new Error('game not found');
    this.host = h;
    this.peerId = h.attach(this);
  }

  send(data: Uint8Array): void {
    const h = this.host;
    const copy = data.slice();
    if (h) queueMicrotask(() => h.onData?.(this.peerId, copy));
  }

  close(): void {
    this.host?.detach(this.peerId);
    this.host = null;
  }

  closedByHost(): void {
    this.host = null;
    queueMicrotask(() => this.onClose?.('host left'));
  }
}

export function loopbackBackend(): NetBackend {
  const hub = new Hub();
  return { name: 'loopback', host: () => new LoopHost(hub), client: () => new LoopClient(hub) };
}
