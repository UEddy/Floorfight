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
const MATCH_ACCOUNT = discriminator("accounts", "Match");

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

export type MatchState = "Open" | "Locked" | "Settled" | "Refunding";
const STATES: MatchState[] = ["Open", "Locked", "Settled", "Refunding"];

export interface MatchAccount {
  matchId: bigint;
  stake: bigint;
  maxPlayers: number;
  count: number;
  /** Base58, and only the first `count` entries are real players. */
  players: string[];
  state: MatchState;
  joinDeadline: number;
  settleDeadline: number;
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
  const b = Buffer.from(data);
  if (b.length < MATCH_ACCOUNT_SIZE) {
    throw new Error(`match account is ${b.length} bytes, expected ${MATCH_ACCOUNT_SIZE}`);
  }
  if (!b.subarray(0, 8).equals(MATCH_ACCOUNT)) {
    throw new Error("that account is not a Match: wrong discriminator");
  }

  const count = b.readUInt8(M.count);
  if (count > MAX_PLAYERS) throw new Error(`match claims ${count} players`);
  const players: string[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    players.push(bs58.encode(b.subarray(M.players + i * 32, M.players + i * 32 + 32)));
  }
  const stateByte = b.readUInt8(M.state);
  const state = STATES[stateByte];
  if (!state) throw new Error(`match state byte ${stateByte} is not a known state`);

  return {
    matchId: b.readBigUInt64LE(M.matchId),
    stake: b.readBigUInt64LE(M.stake),
    maxPlayers: b.readUInt8(M.maxPlayers),
    count,
    players,
    state,
    joinDeadline: Number(b.readBigInt64LE(M.joinDeadline)),
    settleDeadline: Number(b.readBigInt64LE(M.settleDeadline)),
    logHash: Uint8Array.from(b.subarray(M.logHash, M.logHash + 32)),
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
  return [env.RPC_URL, env.PROGRAM_ID, env.RESOLVER_KEYPAIR_PATH]
    .some((v) => v !== undefined && v !== "");
}

/** Instruction data for settle: discriminator, placements, log hash. */
export function settleData(placements: number[], logHash: Uint8Array): Buffer {
  if (placements.length !== PLACES) throw new Error("placements must have three entries");
  if (logHash.length !== 32) throw new Error("log hash must be 32 bytes");
  for (const p of placements) {
    if (!Number.isInteger(p) || p < 0 || p > 255) throw new Error(`placement ${p} is not a byte`);
  }
  return Buffer.concat([SETTLE_IX, Buffer.from(placements), Buffer.from(logHash)]);
}
