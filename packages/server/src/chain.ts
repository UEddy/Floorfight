/**
 * The chain's data, without the chain.
 *
 * Discriminators, account layouts, roster and placement derivation: the parts
 * that are pure functions of bytes. None of it imports @solana/web3.js, which
 * matters more than it sounds like. A free only server never touches the chain
 * at all, and on the droplet that import alone is seconds of startup and tens
 * of megabytes of heap on a box that has 512 MB. chainrpc.ts holds the half
 * that needs a network and a key, and nothing loads it unless a resolver is
 * configured.
 *
 * The IDL is read for the things that must match the program exactly and
 * cannot be eyeballed: the program address and the eight byte discriminators.
 * The field layouts are written out by hand rather than going through
 * @coral-xyz/anchor, because they are fixed size structs that cannot change
 * without somebody editing the program, and when one does the LiteSVM tests
 * that build a settle instruction and decode a real match account fail. That
 * is a better place to find out than production.
 */

import bs58 from "bs58";
import idlJson from "../../../idl/arena.json";
import type { RosterEntry, Standing } from "../../shared/protocol";
import type { Currency } from "../../shared/tiers";

interface IdlFile {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
}
const idl = idlJson as unknown as IdlFile;

/** The program this build of the IDL belongs to. */
export const IDL_ADDRESS = idl.address;

function discriminator(kind: "instructions" | "accounts", name: string): Buffer {
  const found = idl[kind].find((e) => e.name === name);
  if (!found) throw new Error(`the IDL has no ${kind} entry called ${name}`);
  if (found.discriminator.length !== 8) throw new Error(`${name} discriminator is not 8 bytes`);
  return Buffer.from(found.discriminator);
}

const SETTLE_IX = discriminator("instructions", "settle");
const LOCK_IX = discriminator("instructions", "lock_match");
const MATCH_ACCOUNT = discriminator("accounts", "Match");
const SETTLE_TOKEN_IX = discriminator("instructions", "settle_token_match");
const LOCK_TOKEN_IX = discriminator("instructions", "lock_token_match");
const TOKEN_MATCH_ACCOUNT = discriminator("accounts", "TokenMatch");

/** Program constants, mirrored from programs/arena/src/lib.rs. */
export const MAX_PLAYERS = 6;
export const PLACES = 3;
export const NO_PLACE = 255;

/**
 * Match account layout, after the eight byte account discriminator.
 *
 * Borsh writes these in declaration order with no padding, and every field is
 * fixed size, so plain offsets are enough. The unit-only MatchState enum is
 * one byte.
 *
 * A TokenMatch is the same struct with the mint's 32 bytes inserted after the
 * creator, so its layout is this one with every later field moved along by
 * 32 (see `layout`).
 */
const M = {
  matchId: 8,
  creator: 16,
  stake: 48,
  maxPlayers: 56,
  count: 57,
  players: 58,
  state: 58 + 32 * MAX_PLAYERS,
  joinDeadline: 59 + 32 * MAX_PLAYERS,
  settleDeadline: 67 + 32 * MAX_PLAYERS,
  placements: 75 + 32 * MAX_PLAYERS,
  payouts: 78 + 32 * MAX_PLAYERS,
  claimed: 102 + 32 * MAX_PLAYERS,
  logHash: 103 + 32 * MAX_PLAYERS,
  bump: 135 + 32 * MAX_PLAYERS,
} as const;
export const MATCH_ACCOUNT_SIZE = M.bump + 1;

/** Where the mint sits in a TokenMatch. */
const TOKEN_MINT_OFFSET = 48;
type Layout = { [K in keyof typeof M]: number };
const TM: Layout = Object.fromEntries(
  Object.entries(M).map(([k, v]) => [k, v >= TOKEN_MINT_OFFSET ? v + 32 : v]),
) as Layout;
export const TOKEN_MATCH_ACCOUNT_SIZE = TM.bump + 1;

/**
 * Which escrow a match lives in, and its u64 id there.
 *
 * SOL matches and token matches are separate accounts with separate id
 * spaces (seeds "match" and "tmatch"), so the same number can name one of
 * each. The string form the server and the page use keeps them apart: a SOL
 * match is its bare number, as it always was, and a token match is "skr-"
 * and the number. That string is the room id, the match log's file name and
 * the log's matchId, so the log itself says which currency it was played for
 * and that is covered by the hash settled on chain.
 */
export interface MatchRef {
  currency: Currency;
  id: bigint;
}

const SOL_REF_RE = /^(0|[1-9][0-9]{0,19})$/;
const SKR_REF_RE = /^skr-(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

/** Parse a match id string. Null for anything that is not exactly one of the two forms. */
export function parseMatchRef(s: string): MatchRef | null {
  let m = SOL_REF_RE.exec(s);
  let currency: Currency = "sol";
  if (!m) {
    m = SKR_REF_RE.exec(s);
    currency = "skr";
  }
  if (!m) return null;
  const id = BigInt(m[1]);
  if (id > MAX_U64) return null;
  return { currency, id };
}

/** The string form of a match ref: the room id and the log's matchId. */
export function matchKey(ref: MatchRef): string {
  return ref.currency === "sol" ? ref.id.toString() : `skr-${ref.id}`;
}

export type MatchState = "Open" | "Locked" | "Settled" | "Refunding";
const STATES: MatchState[] = ["Open", "Locked", "Settled", "Refunding"];

export interface MatchAccount {
  /** "sol" for a Match, "skr" for a TokenMatch. */
  currency: Currency;
  /** Base58 mint of a token match's pot; null for SOL. */
  mint: string | null;
  matchId: bigint;
  stake: bigint;
  maxPlayers: number;
  count: number;
  /** Base58, and only the first `count` entries are real players. */
  players: string[];
  state: MatchState;
  joinDeadline: number;
  settleDeadline: number;
  /** Slot numbers in finishing order, NO_PLACE for unused. */
  placements: number[];
  /** Paid for first, second and third: lamports, or raw token units. */
  payouts: bigint[];
  /** Bit i set once slot i has claimed. */
  claimed: number;
  logHash: Uint8Array;
}

/**
 * Decode a Match account.
 *
 * The account discriminator is checked first, so handing this the wrong kind
 * of account is an error rather than a plausible looking match with nonsense
 * in it.
 */
export function decodeMatch(data: Buffer | Uint8Array): MatchAccount {
  return decodeWith(Buffer.from(data), M, MATCH_ACCOUNT, "Match", null);
}

/** Decode a TokenMatch account: the same checks, the token layout, and its mint. */
export function decodeTokenMatch(data: Buffer | Uint8Array): MatchAccount {
  const b = Buffer.from(data);
  return decodeWith(b, TM, TOKEN_MATCH_ACCOUNT, "TokenMatch", TOKEN_MINT_OFFSET);
}

function decodeWith(
  b: Buffer, L: Layout, disc: Buffer, name: string, mintAt: number | null,
): MatchAccount {
  const size = L.bump + 1;
  if (b.length < size) {
    throw new Error(`${name} account is ${b.length} bytes, expected ${size}`);
  }
  if (!b.subarray(0, 8).equals(disc)) {
    throw new Error(`that account is not a ${name}: wrong discriminator`);
  }

  const count = b.readUInt8(L.count);
  if (count > MAX_PLAYERS) throw new Error(`match claims ${count} players`);
  const players: string[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    players.push(bs58.encode(b.subarray(L.players + i * 32, L.players + i * 32 + 32)));
  }
  const stateByte = b.readUInt8(L.state);
  const state = STATES[stateByte];
  if (!state) throw new Error(`match state byte ${stateByte} is not a known state`);

  return {
    currency: mintAt === null ? "sol" : "skr",
    mint: mintAt === null ? null : bs58.encode(b.subarray(mintAt, mintAt + 32)),
    matchId: b.readBigUInt64LE(L.matchId),
    stake: b.readBigUInt64LE(L.stake),
    maxPlayers: b.readUInt8(L.maxPlayers),
    count,
    players,
    state,
    joinDeadline: Number(b.readBigInt64LE(L.joinDeadline)),
    settleDeadline: Number(b.readBigInt64LE(L.settleDeadline)),
    placements: [0, 1, 2].map((i) => b.readUInt8(L.placements + i)),
    payouts: [0, 1, 2].map((i) => b.readBigUInt64LE(L.payouts + i * 8)),
    claimed: b.readUInt8(L.claimed),
    logHash: Uint8Array.from(b.subarray(L.logHash, L.logHash + 32)),
  };
}

/**
 * The roster for a staked match, in slot order.
 *
 * Slot is the index in the account's `players` array, which the program fills
 * in join order and then never changes. Taking it from here rather than from
 * connection order is the whole reason settlement and simulation agree about
 * who slot 3 was: the placements the resolver submits are indices into this.
 */
export function rosterFromMatch(m: MatchAccount): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let slot = 0; slot < m.count; slot++) {
    out.push({ slot, wallet: m.players[slot], collection: null, mint: null });
  }
  return out;
}

/**
 * Placements for the program: slot numbers in finishing order.
 *
 * The program pays three places when there are three or more players and
 * everything to first otherwise, and it requires the unused entries to be
 * NO_PLACE. It also rejects a slot at or above the player count and the same
 * slot twice, so this builds exactly what it will accept and nothing looser.
 */
export function placementsFrom(standings: Standing[], count: number): number[] {
  const places = count >= 3 ? 3 : 1;
  const out = [NO_PLACE, NO_PLACE, NO_PLACE];
  for (let i = 0; i < places; i++) {
    const row = standings[i];
    if (!row) throw new Error(`standings have no place ${i + 1} to settle`);
    if (row.slot < 0 || row.slot >= count) {
      throw new Error(`place ${i + 1} names slot ${row.slot}, which is not in a ${count} player match`);
    }
    if (out.includes(row.slot)) throw new Error(`slot ${row.slot} placed twice`);
    out[i] = row.slot;
  }
  return out;
}

/**
 * Is there any chain configuration at all?
 *
 * Here rather than in chainrpc so that index.ts can ask the question without
 * importing the module that answers it: importing chainrpc means importing
 * @solana/web3.js, and the whole point of the split is that a free only
 * server does not.
 */
export function hasChainEnv(env: NodeJS.ProcessEnv): boolean {
  return [env.RPC_URL, env.PROGRAM_ID, env.RESOLVER_KEYPAIR_PATH, env.SKR_POT_MINT]
    .some((v) => v !== undefined && v !== "");
}

/**
 * Instruction data for settle (or settle_token_match, which takes the same
 * two arguments): discriminator, placements, log hash.
 */
export function settleData(
  placements: number[], logHash: Uint8Array, currency: Currency = "sol",
): Buffer {
  if (placements.length !== PLACES) throw new Error("placements must have three entries");
  if (logHash.length !== 32) throw new Error("log hash must be 32 bytes");
  for (const p of placements) {
    if (!Number.isInteger(p) || p < 0 || p > 255) throw new Error(`placement ${p} is not a byte`);
  }
  const ix = currency === "sol" ? SETTLE_IX : SETTLE_TOKEN_IX;
  return Buffer.concat([ix, Buffer.from(placements), Buffer.from(logHash)]);
}

/** Instruction data for lock_match or lock_token_match: the discriminator, nothing else. */
export function lockData(currency: Currency = "sol"): Buffer {
  return Buffer.from(currency === "sol" ? LOCK_IX : LOCK_TOKEN_IX);
}

/**
 * getProgramAccounts filters for the Open matches at one stake.
 *
 * Three filters, all of which the RPC node applies before anything is sent:
 * the exact size of a Match account, the stake bytes, and the state byte. The
 * discriminator is checked again when each result is decoded. Returned as
 * plain data so this module still does not import web3.js.
 */
export function openMatchFilters(stake: bigint): {
  dataSize: number; memcmp: { offset: number; bytes: string }[];
} {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(stake);
  return {
    dataSize: MATCH_ACCOUNT_SIZE,
    memcmp: [
      { offset: 0, bytes: bs58.encode(MATCH_ACCOUNT) },
      { offset: M.stake, bytes: bs58.encode(le) },
      // MatchState::Open is variant 0.
      { offset: M.state, bytes: bs58.encode(Buffer.from([0])) },
    ],
  };
}

/**
 * getProgramAccounts filters for the Open token matches at one stake in one
 * mint. The mint is a filter, not just a check afterwards: the allowlist can
 * hold more than one mint, and this server only lists, opens and settles
 * matches for the one it was configured with (SKR_POT_MINT).
 */
export function openTokenMatchFilters(mint: string, stake: bigint): {
  dataSize: number; memcmp: { offset: number; bytes: string }[];
} {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(stake);
  return {
    dataSize: TOKEN_MATCH_ACCOUNT_SIZE,
    memcmp: [
      { offset: 0, bytes: bs58.encode(TOKEN_MATCH_ACCOUNT) },
      { offset: TOKEN_MINT_OFFSET, bytes: mint },
      { offset: TM.stake, bytes: bs58.encode(le) },
      { offset: TM.state, bytes: bs58.encode(Buffer.from([0])) },
    ],
  };
}

/**
 * Decimals of a classic SPL mint, from its raw account data: one byte at
 * offset 44 of the 82 byte layout. Read from the chain, never written down,
 * because the decimals of the real SKR mint are not something this code
 * gets to assume.
 */
export function mintDecimals(data: Buffer | Uint8Array): number {
  const b = Buffer.from(data);
  if (b.length !== 82) throw new Error(`mint account is ${b.length} bytes, not a classic SPL mint`);
  if (b.readUInt8(45) !== 1) throw new Error("mint is not initialized");
  const d = b.readUInt8(44);
  if (d > 18) throw new Error(`mint claims ${d} decimals`);
  return d;
}

/** What a match pays each place, from the pot, as the program computes it. */
export function payoutsFor(stake: bigint, count: number): bigint[] {
  const pot = stake * BigInt(count);
  if (count < 3) return [pot, 0n, 0n];
  const second = (pot * 3000n) / 10000n;
  const third = (pot * 2000n) / 10000n;
  return [pot - second - third, second, third];
}
