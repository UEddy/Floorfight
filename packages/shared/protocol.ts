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

export const PROTOCOL_VERSION = 7;

/**
 * Version of the match log, which is also the version of the rules a replay
 * has to run it under. Bumped when the simulation changes what the same
 * inputs produce: 5 added horizontal acceleration and movement and bloom
 * spread, so a v4 log replayed by this build would not reproduce its match.
 * 6 refuses a lag compensated hit on a victim who is behind cover at the
 * tick the shot is resolved.
 */
export const LOG_VERSION = 6;

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
  | {
      t: "join"; v: number; matchId: string; wallet: string; sig: string;
      /**
       * Holders only: the NFT the player wants on their head. A request, not
       * a claim. The server asks the chain who owns it and puts it in the
       * roster only if the answer is this wallet; anything else plays with
       * the default face and is not an error. Not part of the signed
       * message: the worst a tampered mint can do is change a face, and the
       * ownership check catches that anyway.
       */
      mint?: string;
    }
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
 * In a staked match the server checks the wallet is actually a participant in
 * matchId before it allocates a slot, and the slot index comes from the
 * on-chain roster order, never from connection order, so a replay assigns the
 * same slots every time.
 *
 * A free room has no roster to check against: it accepts any key that signs
 * the nonce, and slots go in join order. That is not a weakening of the above,
 * it is the absence of the thing the above protects. Nothing is staked, there
 * is no payout to misdirect, and the slot order a free match ended up with is
 * recorded in its log, so it still replays. The only identity a guest has is
 * the key it made up on page load.
 *
 * Character ownership is resolved here too, server side, by RPC against the
 * holder's account. A client claiming a mint it does not own is quietly given
 * the default skin rather than an error, because a cosmetic lie is not worth a
 * failed join.
 */
export function joinMessage(matchId: string, nonce: string): string {
  return `floorfight:join:v${PROTOCOL_VERSION}:${matchId}:${nonce}`;
}

/**
 * The exact shape of a join message, as a pattern.
 *
 * This exists for anything that has to decide whether a string it was handed
 * is a join message and nothing else. The mobile shell is the reason: it will
 * sign a join message for the WebView, and the only thing standing between
 * that and signing whatever the page asks for is a check this strict. It
 * keeps its own copy of this pattern, deliberately, so a compromised bundle
 * cannot widen it, and this is the copy that is tested.
 *
 * Nothing matching it can be a Solana transaction, which is the other thing
 * an off-chain signing path has to be sure of.
 */
export const JOIN_MESSAGE_RE =
  /^floorfight:join:v(\d{1,3}):([A-Za-z0-9_-]{1,64}):([1-9A-HJ-NP-Za-km-z]{16,64})$/;

/* -------------------------------------------------------------- server --- */

export interface SnapshotPlayer {
  s: number; // slot
  x: number;
  z: number;
  e: number; // feet height. `y` was already taken by yaw when v1 shipped and
             // renaming it now would silently swap two numbers of the same
             // type at every call site, so the new field got the new name.
  w: number; // vertical velocity
  u: number; // horizontal velocity, x
  v: number; // horizontal velocity, z
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
 * `w`, `u` and `v` are there for one reason: the local player's prediction
 * replays its unacknowledged inputs from the authoritative state, and with
 * gravity, jumping and acceleration in the simulation that state includes
 * velocity. Left out, a reconcile in the middle of a jump would restart the
 * arc from a standstill, and one in the middle of a run would restart the
 * run, and the camera would stutter at both. They cost a few bytes per player
 * per snapshot and are only ever read by their owner.
 */

export type ServerMsg =
  | {
      t: "challenge"; v: number; nonce: string;
      /**
       * The free room this connection would be seated in, or null if none is
       * open. Sent with the challenge rather than looked up at join time so
       * that a guest signs the id of the room it actually gets: the match id
       * is inside the signed message, and a signature over a matchmaking
       * alias would bind nothing in particular.
       *
       * A staked client ignores this and signs the match id it read off the
       * chain.
       */
      freeMatchId: string | null;
    }
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
  | { t: "kick"; reason: string }
  | LobbyView;

/** Fewer than this on chain and a holders match cannot be locked. */
export const MIN_PLAYERS_TO_LOCK = 2;

/**
 * How a holders lobby stands, sent to everyone in it whenever it changes and
 * at every poll. Every number is the chain's, read off the match account.
 */
export interface LobbyView {
  t: "lobby";
  matchId: string;
  /** waiting, locking (lock sent, room opening), expired or over. */
  phase: "waiting" | "locking" | "expired" | "over";
  count: number;
  maxPlayers: number;
  /** Lamports per player, decimal. */
  stake: string;
  /** Unix seconds. */
  joinDeadline: number;
  /** One entry per joined slot: is that player connected in the lobby. */
  present: boolean[];
  /** Seconds before the deadline at which the match locks regardless. */
  lockBefore: number;
}

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

/**
 * The finishing order.
 *
 * Total and deterministic, because it decides who gets paid: kills
 * descending, then fewer deaths, then lower slot. Slot is the final tiebreak
 * precisely because it can never tie, which means there is no case where the
 * standings depend on iteration order or timing.
 *
 * Here rather than in the server so that a replay computes the order with the
 * same code that produced it. A verifier that re-implemented this would be
 * checking its own opinion of the rules.
 */
export function standingsFrom(
  players: readonly { kills: number; deaths: number }[],
  roster: readonly RosterEntry[],
): Standing[] {
  const rows: Standing[] = players.map((p, slot) => ({
    slot,
    wallet: roster[slot]?.wallet ?? "",
    kills: p.kills,
    deaths: p.deaths,
    place: 0,
  }));
  rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.slot - b.slot);
  rows.forEach((r, i) => { r.place = i + 1; });
  return rows;
}

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

/**
 * Read a canonical log back.
 *
 * The file written to disk is the canonical form itself, byte for byte, so
 * that the hash on chain is the hash of the file a verifier downloads. That
 * form is positional, so this is the only thing that knows how to turn it
 * back into a MatchLog for the replay to run over.
 *
 * Returns null on anything that is not the shape canonicalise produces.
 * canonicalise(decanonicalise(s)) has to equal s, and there is a test for it:
 * if that ever stops being true, a verifier would rehash to a different value
 * and conclude the server lied.
 */
export function decanonicalise(text: string): MatchLog | null {
  let a: unknown;
  try {
    a = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || a.length !== 8) return null;
  const [v, matchId, map, spreadSalt, roster, startedAt, ticks, standings] = a as unknown[];
  if (typeof v !== "number" || typeof matchId !== "string" || typeof map !== "string") return null;
  if (typeof spreadSalt !== "string" || typeof startedAt !== "number") return null;
  if (!Array.isArray(roster) || !Array.isArray(ticks) || !Array.isArray(standings)) return null;

  const log: MatchLog = {
    v, matchId, map, spreadSalt, startedAt,
    roster: roster.map((r) => {
      const [slot, wallet, collection, mint] = r as unknown[];
      return {
        slot: slot as number,
        wallet: wallet as string,
        collection: (collection ?? null) as string | null,
        mint: (mint ?? null) as string | null,
      };
    }),
    ticks: ticks.map((t) => {
      const [tick, inputs] = t as unknown[];
      return {
        tick: tick as number,
        inputs: (inputs as unknown[]).map((i) => {
          if (i === null) return null;
          const [itick, view, moveX, moveY, yaw, pitch, fire, jump, reload, weapon] =
            i as number[];
          return {
            tick: itick, view, moveX, moveY, yaw, pitch,
            fire: fire as 0 | 1, jump: jump as 0 | 1, reload: reload as 0 | 1, weapon,
          };
        }),
      };
    }),
    standings: standings.map((s) => {
      const [slot, wallet, kills, deaths, place] = s as unknown[];
      return {
        slot: slot as number,
        wallet: wallet as string,
        kills: kills as number,
        deaths: deaths as number,
        place: place as number,
      };
    }),
  };
  return log;
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
