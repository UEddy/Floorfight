/**
 * Wire protocol between phone and server.
 *
 * Trust boundary: everything in ClientMsg is hostile until proven otherwise.
 * The server reads intents from it and nothing else. There is deliberately no
 * message a client can send that asserts a position, a hit, a kill or a score.
 *
 * Transport is JSON over WebSocket for v1. At 20 Hz with six players and the
 * fields a snapshot now carries, that is roughly 20 KB/s down per client,
 * which is still fine on a phone. Move to a binary encoding only when
 * debugging JSON stops being worth the bytes.
 */

import type { HitEvent, Input } from "./sim";
import { PITCH_LIMIT, YAW_UNITS } from "./sim";

export const PROTOCOL_VERSION = 5;

/** Abuse limits. Exceed any of these and the connection is closed. */
export const MAX_MSG_BYTES = 4096;
export const MAX_INPUTS_PER_BATCH = 12;
export const MAX_MSGS_PER_SECOND = 90;
export const NONCE_TTL_MS = 30_000;

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

/**
 * Shape check for one input off the wire. Range clamping happens in sim.step,
 * but a value that is not a finite number would poison the simulation, so
 * anything malformed is rejected at the boundary instead.
 */
export function isWellFormedInput(v: unknown): v is Input {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const nums = ["tick", "view", "moveX", "moveY", "yaw", "pitch", "weapon"];
  for (const k of nums) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  if (o.fire !== 0 && o.fire !== 1) return false;
  if (o.jump !== 0 && o.jump !== 1) return false;
  return o.reload === 0 || o.reload === 1;
}

/* -------------------------------------------------------------- client --- */

export type ClientMsg =
  | { t: "join"; v: number; matchId: string; wallet: string; sig: string }
  | { t: "input"; batch: Input[] } // resends the last few ticks, server dedupes
  | { t: "pong"; id: number };

/**
 * join carries an ed25519 signature over the exact string
 *
 *   floorfight:join:v<PROTOCOL_VERSION>:<matchId>:<nonce>
 *
 * where nonce was issued by the server on this socket moments earlier. Binding
 * the matchId into the signed message means a signature captured from one match
 * cannot be replayed into another. The nonce is single use and expires after
 * NONCE_TTL_MS.
 *
 * The server checks the wallet is actually a participant in matchId before it
 * allocates a slot. Slot index comes from the on-chain roster order, never from
 * connection order, so a replay assigns the same slots every time.
 *
 * Character ownership is resolved here too, server side, by RPC against the
 * holder's account. A client claiming a mint it does not own is quietly given
 * the default skin rather than an error, because a cosmetic lie is not worth a
 * failed join.
 */
export function joinMessage(matchId: string, nonce: string): string {
  return `floorfight:join:v${PROTOCOL_VERSION}:${matchId}:${nonce}`;
}

/* -------------------------------------------------------------- server --- */

export interface SnapshotPlayer {
  s: number; // slot
  x: number;
  z: number;
  e: number; // feet height. `y` was already taken by yaw when v1 shipped and
             // renaming it now would silently swap two numbers of the same
             // type at every call site, so the new field got the new name.
  w: number; // vertical velocity
  y: number; // yaw units
  p: number; // pitch quantised
  h: number; // hp
  k: number; // kills
  d: number; // deaths, shown on the scoreboard and the standings tiebreak
  a: 0 | 1;  // alive
  g: number; // weapon held, an index into WEAPONS
  m: number; // rounds left in that weapon's magazine
  r: number; // ticks of reload still to run, 0 if not reloading
  f: 0 | 1;  // fired at least once since the previous snapshot
}

/**
 * `w` is there for one reason: the local player's prediction replays its
 * unacknowledged inputs from the authoritative state, and with gravity and
 * jumping in the simulation that state now includes vertical velocity. Left
 * out, a reconcile in the middle of a jump would restart the arc from a
 * standstill and the camera would stutter at the top of every jump. It costs
 * a few bytes per player per snapshot and it is only ever read by its owner.
 */

export type ServerMsg =
  | { t: "challenge"; v: number; nonce: string }
  | {
      t: "accepted"; slot: number; tick: number; startsInMs: number;
      roster: RosterEntry[];
      /**
       * sha256 of this match's pellet spread salt, as hex.
       *
       * The commit half of a commit and reveal. It arrives before the first
       * shot, and the salt itself arrives in the `over` message and in the
       * match log when the match is finished. Anyone who kept this value can
       * check that the salt they were given hashes to it, which is what rules
       * out a server picking a spread pattern after seeing the round.
       *
       * Keep it. The server will not send it again.
       */
      spreadCommit: string;
    }
  | {
      t: "snap"; tick: number; ack: number; rtt: number;
      players: SnapshotPlayer[]; hits: HitEvent[];
    }
  | {
      t: "over"; tick: number; standings: Standing[]; logHash: string;
      /** The reveal: the salt committed to at join, as hex. */
      spreadSalt: string;
    }
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
 * `ack` is the highest client input tick the server has consumed on this
 * connection. The client keeps everything after it and replays those inputs on
 * top of the authoritative snapshot to reconcile its prediction.
 *
 * `rtt` is the round trip time the server measured on this connection, in
 * milliseconds, from its own ping and the client's pong. It exists so the
 * debug overlay can show a ping on a phone, and it is display only: lag
 * compensation never reads it, because the rewind target travels inside each
 * input instead. A client that answers pings late or not at all gets a wrong
 * number on its own screen and changes nothing else.
 */

/* ----------------------------------------------------------- match log --- */

/**
 * The verifiable artifact. Every input the server accepted, in tick order,
 * plus the roster and the id of the map it was played on. Re-running sim.step
 * over this reproduces the standings exactly, including lag compensation,
 * because the rewind target travels inside each input rather than being
 * derived from live latency.
 *
 * sha256 of the canonical serialisation is written on chain alongside the
 * payout, so a loser can download the log, replay it, and check the winner
 * rather than taking the resolver's word for it. The salt is inside that
 * hash, so a log cannot be re-salted after the fact without the payout's own
 * commitment no longer matching.
 *
 * This does not make settlement trustless. It makes it auditable. That is the
 * honest claim and the achievable one, and it is the one that goes in the deck.
 */
export interface MatchLog {
  v: number;
  matchId: string;
  map: string;
  /**
   * The pellet spread salt, as hex, written when the match ends. A replay
   * needs it to reproduce the shots, and the hash of it was published to
   * every player at join.
   */
  spreadSalt: string;
  roster: RosterEntry[];
  startedAt: number;
  ticks: { tick: number; inputs: (Input | null)[] }[];
  standings: Standing[];
}

export function canonicalise(log: MatchLog): string {
  // Fixed key order, no whitespace. Do not swap this for JSON.stringify on the
  // raw object: key order there follows insertion order and would change the
  // hash for a semantically identical log.
  const ticks = log.ticks.map((t) => [
    t.tick,
    t.inputs.map((i) =>
      i
        ? [i.tick, i.view, i.moveX, i.moveY, i.yaw, i.pitch, i.fire, i.jump,
          i.reload, i.weapon]
        : null,
    ),
  ]);
  const roster = log.roster.map((r) => [r.slot, r.wallet, r.collection, r.mint]);
  const standings = log.standings.map((s) => [s.slot, s.wallet, s.kills, s.deaths, s.place]);
  return JSON.stringify([
    log.v, log.matchId, log.map, log.spreadSalt, roster, log.startedAt, ticks, standings,
  ]);
}
