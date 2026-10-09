// Phones: real Wi-Fi networking through our native Capacitor plugin "LanNet"
// (Android: NSD + TCP sockets, iOS: Bonjour + Network.framework). Games are found
// automatically on the local network; no IP addresses to type.

import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { type ClientTransport, fromBase64, type GameInfo, type HostTransport, type NetBackend, toBase64 } from './transport';

interface NativeGame {
  id: string;
  name: string;
  host: string;
  port: number;
}

interface LanNetPlugin {
  startHost(opts: { name: string }): Promise<{ port: number }>;
  stopHost(): Promise<void>;
  sendToPeer(opts: { peer: string; data: string }): Promise<void>;
  broadcast(opts: { data: string }): Promise<void>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(opts: { host: string; port: number }): Promise<void>;
  sendToHost(opts: { data: string }): Promise<void>;
  disconnect(): Promise<void>;
  addListener(event: 'peerJoined' | 'peerLeft', cb: (e: { peer: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'peerData', cb: (e: { peer: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'gamesChanged', cb: (e: { games: NativeGame[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'hostData', cb: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'hostClosed', cb: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
}

const LanNet = registerPlugin<LanNetPlugin>('LanNet');

class NativeHost implements HostTransport {
  private handles: PluginListenerHandle[] = [];
  onPeer?: (peer: string) => void;
  onData?: (peer: string, data: Uint8Array) => void;
  onLeave?: (peer: string) => void;

  async start(name: string): Promise<void> {
    this.handles.push(
      await LanNet.addListener('peerJoined', (e) => this.onPeer?.(e.peer)),
      await LanNet.addListener('peerLeft', (e) => this.onLeave?.(e.peer)),
      await LanNet.addListener('peerData', (e) => this.onData?.(e.peer, fromBase64(e.data))),
    );
    await LanNet.startHost({ name });
  }

  stop(): void {
    void LanNet.stopHost();
    for (const h of this.handles) void h.remove();
    this.handles = [];
  }

  send(peer: string, data: Uint8Array): void {
    void LanNet.sendToPeer({ peer, data: toBase64(data) });
  }

  broadcast(data: Uint8Array): void {
    void LanNet.broadcast({ data: toBase64(data) });
  }
}

class NativeClient implements ClientTransport {
  private handles: PluginListenerHandle[] = [];
  private games = new Map<string, NativeGame>();
  onData?: (data: Uint8Array) => void;
  onClose?: (reason: string) => void;

  async discover(onList: (games: GameInfo[]) => void): Promise<() => void> {
    const h = await LanNet.addListener('gamesChanged', (e) => {
      this.games = new Map(e.games.map((g) => [g.id, g]));
      onList(e.games.map((g) => ({ id: g.id, name: g.name, address: g.id })));
    });
    await LanNet.startDiscovery();
    return () => {
      void LanNet.stopDiscovery();
      void h.remove();
    };
  }

  async connect(game: GameInfo): Promise<void> {
    const g = this.games.get(game.address);
    if (!g) throw new Error('Game not found');
    this.handles.push(
      await LanNet.addListener('hostData', (e) => this.onData?.(fromBase64(e.data))),
      await LanNet.addListener('hostClosed', (e) => this.onClose?.(e.reason || 'Disconnected')),
    );
    await LanNet.connect({ host: g.host, port: g.port });
  }

  send(data: Uint8Array): void {
    void LanNet.sendToHost({ data: toBase64(data) });
  }

  close(): void {
    void LanNet.disconnect();
    for (const h of this.handles) void h.remove();
    this.handles = [];
  }
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativeLanBackend(): NetBackend {
  return { name: 'wifi', host: () => new NativeHost(), client: () => new NativeClient() };
}
