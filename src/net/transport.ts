// How devices talk. The game code only sees these interfaces; the actual wire is
// either the native Wi-Fi plugin (phones), a dev relay (browsers), or in-memory (tests).

export interface GameInfo {
  id: string;
  name: string;
  /** Opaque address understood by the backend that discovered it. */
  address: string;
}

export interface HostTransport {
  /** Starts listening and advertising the game on the local network. */
  start(name: string): Promise<void>;
  stop(): void;
  send(peer: string, data: Uint8Array): void;
  broadcast(data: Uint8Array): void;
  onPeer?: (peer: string) => void;
  onData?: (peer: string, data: Uint8Array) => void;
  onLeave?: (peer: string) => void;
}

export interface ClientTransport {
  /** Starts looking for games; returns a function that stops looking. */
  discover(onList: (games: GameInfo[]) => void): Promise<() => void>;
  connect(game: GameInfo): Promise<void>;
  send(data: Uint8Array): void;
  close(): void;
  onData?: (data: Uint8Array) => void;
  onClose?: (reason: string) => void;
}

export interface NetBackend {
  readonly name: string;
  host(): HostTransport;
  client(): ClientTransport;
}

export function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
