// Browser transport that talks to scripts/lan-dev-server.ts (development / desktop play).

import type { ClientTransport, GameInfo, HostTransport, NetBackend } from './transport';

export function relayUrl(): string {
  const param = new URLSearchParams(location.search).get('relay');
  if (param) return param.startsWith('ws') ? param : `ws://${param}`;
  return `ws://${location.hostname || 'localhost'}:8787`;
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('relay timeout'));
    }, 1500);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('relay unavailable'));
    };
  });
}

class RelayHost implements HostTransport {
  private ws: WebSocket | null = null;
  onPeer?: (peer: string) => void;
  onData?: (peer: string, data: Uint8Array) => void;
  onLeave?: (peer: string) => void;

  constructor(private readonly url: string) {}

  async start(name: string): Promise<void> {
    const ws = await open(this.url);
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as { op: string; peer?: number };
        if (m.op === 'peer') this.onPeer?.(String(m.peer));
        if (m.op === 'leave') this.onLeave?.(String(m.peer));
        return;
      }
      const buf = new Uint8Array(e.data as ArrayBuffer);
      const peer = (buf[0] << 8) | buf[1];
      this.onData?.(String(peer), buf.subarray(2));
    };
    ws.send(JSON.stringify({ op: 'host', name }));
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendRaw(peer: number, data: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(2 + data.length);
    out[0] = peer >> 8;
    out[1] = peer & 255;
    out.set(data, 2);
    this.ws.send(out);
  }

  send(peer: string, data: Uint8Array): void {
    this.sendRaw(Number(peer), data);
  }

  broadcast(data: Uint8Array): void {
    this.sendRaw(0xffff, data);
  }
}

class RelayClient implements ClientTransport {
  private ws: WebSocket | null = null;
  onData?: (data: Uint8Array) => void;
  onClose?: (reason: string) => void;

  constructor(private readonly url: string) {}

  async discover(onList: (games: GameInfo[]) => void): Promise<() => void> {
    const ws = await open(this.url);
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as { op: string; games?: GameInfo[] };
        if (m.op === 'list') onList(m.games ?? []);
      }
    };
    const poll = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 'list' }));
    poll();
    const t = setInterval(poll, 1000);
    return () => {
      clearInterval(t);
      ws.close();
    };
  }

  async connect(game: GameInfo): Promise<void> {
    const ws = await open(this.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const m = JSON.parse(e.data) as { op: string; reason?: string };
          if (m.op === 'joined') resolve();
          if (m.op === 'error') reject(new Error(m.reason));
          return;
        }
        this.onData?.(new Uint8Array(e.data as ArrayBuffer));
      };
      ws.send(JSON.stringify({ op: 'join', id: game.address }));
    });
    ws.onclose = (e) => this.onClose?.(e.reason || 'Disconnected');
  }

  send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    if (this.ws) this.ws.onclose = null;
    this.ws?.close();
    this.ws = null;
  }
}

/** Returns the relay backend if a relay server answers, else null. */
export async function devRelayBackend(): Promise<NetBackend | null> {
  const url = relayUrl();
  try {
    const ws = await open(url);
    ws.close();
  } catch {
    return null;
  }
  return { name: 'relay', host: () => new RelayHost(url), client: () => new RelayClient(url) };
}
