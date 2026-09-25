/**
 * Wire protocol between phone and server.
 *
 * Trust boundary: everything in ClientMsg is hostile until proven otherwise.
 * The server reads intents from it and nothing else. There is deliberately no
 * message a client can send that asserts a position, a hit, a kill or a score.
 *
 * Transport is JSON over WebSocket for v1. At 20 Hz with six players that is
 * roughly 12 KB/s down per client, which is fine. Move to a binary encoding
 * only if the DevEx of debugging JSON stops being worth it.
 */

import type { HitEvent, Input } from "./sim";
import { PITCH_LIMIT, YAW_UNITS } from "./sim";

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------ quantise --- */

export function quantYaw(radians: number): number {
  const turns = radians / (Math.PI * 2);
  const u = Math.round(turns * YAW_UNITS) | 0;
  return ((u % YAW_UNITS) + YAW_UNITS) % YAW_UNITS;
}

export function quantPitch(radians: number): number {
  const c = radians < -PITCH_LIMIT ? -PITCH_LIMIT : radians > PITCH_LIMIT ? PITCH_LIMIT : radians;
  return Math.round((c / PITCH_LIMIT) * 32767) | 0;
}

export function quantAxis(v: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(c * 127) | 0;
}

/* -------------------------------------------------------------- client --- */

export type ClientMsg =
  | { t: "join"; v: number; matchId: string; wallet: string; sig: string; nonce: string }
  | { t: "input"; batch: Input[] } // resends the last few ticks, server dedupes
  | { t: "pong"; id: number };

/**
 * join carries a wallet signature over `nonce`, issued by the server moments
 * earlier. That proves the socket belongs to the wallet that staked, and the
 * nonce stops a captured join frame being replayed by someone else. The server
 * checks the wallet is actually a participant in matchId before it allocates a
 * slot.
 *
 * Character ownership is resolved here too, server side, by RPC against the
 * holder's account. A client claiming to be wearing an NFT it does not own is
 * simply assigned the default skin.
 */

/* -------------------------------------------------------------- server --- */

export interface SnapshotPlayer {
  s: number; // slot
  x: number;
  z: number;
  y: number; // yaw units
  p: number; // pitch quantised
  h: number; // hp
  k: number; // kills
  a: 0 | 1;  // alive
}

export type ServerMsg =
  | { t: "challenge"; nonce: string }
  | { t: "accepted"; slot: number; tick: number; startsAt: number; roster: RosterEntry[] }
  | { t: "snap"; tick: number; ack: number; players: SnapshotPlayer[]; hits: HitEvent[] }
  | { t: "over"; tick: number; standings: Standing[]; logHash: string }
  | { t: "ping"; id: number }
  | { t: "kick"; reason: string };

export interface RosterEntry {
  slot: number;
  wallet: string;
  collection: string | null; // verified mint collection, or null for default skin
  mint: string | null;
}

export interface Standing {
  slot: number;
  wallet: string;
  kills: number;
  deaths: number;
  place: number;
}

/**
 * `ack` is the highest client input tick the server has consumed for this
 * connection. The client keeps unacknowledged inputs and replays them on top of
 * the authoritative snapshot to reconcile its prediction.
 */

/* ----------------------------------------------------------- match log --- */

/**
 * The verifiable artifact. Every input the server accepted, in tick order,
 * plus the roster and map seed. Re-running sim.step over this reproduces the
 * standings exactly. sha256 of the canonical serialisation is what gets written
 * on chain alongside the payout, so a loser can download the log, replay it and
 * check the winner rather than taking the resolver's word for it.
 *
 * This is the whole security story. It does not make settlement trustless. It
 * makes it auditable, which is the honest claim and the achievable one.
 */
export interface MatchLog {
  v: number;
  matchId: string;
  mapSeed: number;
  roster: RosterEntry[];
  startedAt: number;
  ticks: { tick: number; inputs: (Input | null)[] }[];
  standings: Standing[];
}

export function canonicalise(log: MatchLog): string {
  // Fixed key order, no whitespace. Do not swap this for JSON.stringify on the
  // raw object: key order there depends on insertion order and would change the
  // hash for a semantically identical log.
  const ticks = log.ticks.map((t) => [
    t.tick,
    t.inputs.map((i) => (i ? [i.tick, i.moveX, i.moveY, i.yaw, i.pitch, i.fire] : null)),
  ]);
  const roster = log.roster.map((r) => [r.slot, r.wallet, r.collection, r.mint]);
  const standings = log.standings.map((s) => [s.slot, s.wallet, s.kills, s.deaths, s.place]);
  return JSON.stringify([log.v, log.matchId, log.mapSeed, roster, log.startedAt, ticks, standings]);
}
