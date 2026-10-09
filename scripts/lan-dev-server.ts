// Development relay that stands in for the phones' Wi-Fi networking, so the multiplayer
// mode can be played in browsers (several tabs, or computers on the same network).
//
//   npm run lan-dev        # then open the game in two browsers
//
// Hosts register a game, clients list and join. Binary game messages are relayed:
// host -> server: [u16 peer | 0xffff = everyone][payload], server -> host: [u16 peer][payload].

import { type WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;

interface HostEntry {
  id: number;
  name: string;
  ws: WebSocket;
  peers: Map<number, WebSocket>;
}

const hosts = new Map<number, HostEntry>();
const role = new WeakMap<WebSocket, { host?: HostEntry; joined?: { host: HostEntry; peer: number } }>();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  role.set(ws, {});
  ws.on('message', (raw, isBinary) => {
    const r = role.get(ws)!;
    if (isBinary) {
      const buf = raw as Buffer;
      if (r.host) {
        const peer = buf.readUInt16BE(0);
        const payload = buf.subarray(2);
        if (peer === 0xffff) for (const p of r.host.peers.values()) p.send(payload);
        else r.host.peers.get(peer)?.send(payload);
      } else if (r.joined) {
        const head = Buffer.alloc(2);
        head.writeUInt16BE(r.joined.peer);
        r.joined.host.ws.send(Buffer.concat([head, buf]));
      }
      return;
    }
    const msg = JSON.parse(String(raw)) as { op: string; name?: string; id?: number };
    if (msg.op === 'host') {
      const entry: HostEntry = { id: nextId++, name: String(msg.name ?? 'Game').slice(0, 20), ws, peers: new Map() };
      hosts.set(entry.id, entry);
      r.host = entry;
      ws.send(JSON.stringify({ op: 'hosted', id: entry.id }));
    } else if (msg.op === 'list') {
      ws.send(
        JSON.stringify({ op: 'list', games: [...hosts.values()].map((h) => ({ id: String(h.id), name: h.name, address: String(h.id) })) }),
      );
    } else if (msg.op === 'join') {
      const host = hosts.get(Number(msg.id));
      if (!host) {
        ws.send(JSON.stringify({ op: 'error', reason: 'Game not found' }));
        return;
      }
      const peer = nextId++;
      host.peers.set(peer, ws);
      r.joined = { host, peer };
      host.ws.send(JSON.stringify({ op: 'peer', peer }));
      ws.send(JSON.stringify({ op: 'joined' }));
    }
  });
  ws.on('close', () => {
    const r = role.get(ws);
    if (r?.host) {
      hosts.delete(r.host.id);
      for (const p of r.host.peers.values()) p.close(1000, 'host left');
    }
    if (r?.joined) {
      r.joined.host.peers.delete(r.joined.peer);
      if (r.joined.host.ws.readyState === r.joined.host.ws.OPEN)
        r.joined.host.ws.send(JSON.stringify({ op: 'leave', peer: r.joined.peer }));
    }
  });
});

console.log(`Spot Kick LAN dev relay on ws://0.0.0.0:${PORT}`);
