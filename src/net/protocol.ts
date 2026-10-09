// Wire format. First byte = message type. Rare lobby messages are JSON; the two
// hot messages (inputs 60/s, snapshots 30/s) are compact binary.

import type { Input, Team } from '../match/types';

export const PROTOCOL_VERSION = 1;

export const enum Msg {
  Hello = 1,
  Welcome = 2,
  Lobby = 3,
  Team = 4,
  Start = 5,
  Input = 6,
  Snap = 7,
  Bye = 8,
}

export interface LobbyPlayer {
  slot: number;
  name: string;
  team: Team;
}

export interface HelloMsg {
  name: string;
  version: number;
}
export interface WelcomeMsg {
  slot: number;
}
export interface LobbyMsg {
  players: LobbyPlayer[];
  hostName: string;
  started: boolean;
}
export interface TeamMsg {
  team: Team;
}
export interface StartMsg {
  duration: number;
  players: LobbyPlayer[];
}
export interface ByeMsg {
  reason: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeJson(type: Msg, body: unknown): Uint8Array {
  const json = enc.encode(JSON.stringify(body));
  const out = new Uint8Array(1 + json.length);
  out[0] = type;
  out.set(json, 1);
  return out;
}

export function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(dec.decode(data.subarray(1))) as T;
}

export function msgType(data: Uint8Array): Msg {
  return data[0] as Msg;
}

const clampByte = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));

export function encodeInput(inp: Input): Uint8Array {
  const out = new Uint8Array(5);
  const dv = new DataView(out.buffer);
  out[0] = Msg.Input;
  dv.setInt8(1, clampByte(inp.mx));
  dv.setInt8(2, clampByte(inp.my));
  out[3] = (inp.pass ? 1 : 0) | (inp.shoot ? 2 : 0);
  dv.setInt8(4, inp.dive);
  return out;
}

export function decodeInput(data: Uint8Array): Input {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let mx = dv.getInt8(1) / 127;
  let my = dv.getInt8(2) / 127;
  // Re-normalise so "pushed to the edge" survives the 8-bit rounding.
  const mag = Math.hypot(mx, my);
  if (mag > 0.985) {
    mx /= mag;
    my /= mag;
  }
  return { mx, my, pass: (data[3] & 1) !== 0, shoot: (data[3] & 2) !== 0, dive: dv.getInt8(4) };
}

export function encodeSnap(floats: Float32Array): Uint8Array {
  const out = new Uint8Array(4 + floats.byteLength);
  out[0] = Msg.Snap;
  out.set(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength), 4);
  return out;
}

export function decodeSnapFloats(data: Uint8Array): Float32Array {
  // Copy into an aligned buffer (the incoming view may be at any byte offset).
  const bytes = data.slice(4);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
}
