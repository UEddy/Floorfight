/**
 * Transactions, built here.
 *
 * The page asks for an action on a match id. This file reads the match account
 * from the chain, works out for itself whether that action is possible and
 * what it is worth, and builds the instruction from the program IDL. The page
 * contributes a decimal number and nothing else.
 *
 * It follows that the amounts on the confirmation sheet are the chain's, not
 * the page's. A page that wanted to show someone a stake of 0.01 and have
 * them sign away 10 would have to change the chain to do it.
 */

import { BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import idlJson from "./idl/arena.json";
import { CHAIN, PROGRAM_ID, RPC_URL } from "./config";
import type { EscrowAction } from "./bridge";

const idl = idlJson as unknown as Idl;

/**
 * The IDL is a copy of a build artifact (see scripts/sync-idl.mjs). If it is
 * stale enough to carry a different program address, every instruction built
 * from it would be addressed to the wrong program, so fail at startup rather
 * than at signing time.
 */
const idlAddress = (idlJson as { address?: string }).address;
if (idlAddress !== PROGRAM_ID) {
  throw new Error(
    `IDL is for program ${idlAddress}, this build expects ${PROGRAM_ID}. ` +
    "Run npm run idl:sync.",
  );
}

export const programId = new PublicKey(PROGRAM_ID);
const instructions = new BorshInstructionCoder(idl);
const accounts = new BorshAccountsCoder(idl);

export const connection = new Connection(RPC_URL, "confirmed");

/* ------------------------------------------------------------- state --- */

/** MatchState in the program, in declaration order. */
export type MatchState = "Open" | "Locked" | "Settled" | "Refunding";
const STATES: MatchState[] = ["Open", "Locked", "Settled", "Refunding"];

export interface MatchAccount {
  matchId: bigint;
  stake: bigint;
  maxPlayers: number;
  count: number;
  players: PublicKey[];
  state: MatchState;
  joinDeadline: number;
  settleDeadline: number;
  placements: number[];
  payouts: bigint[];
  claimed: number;
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function configPda(): PublicKey {
  return pda([Buffer.from("config")]);
}

/** Match PDA: seeds are "match" and the u64 id, little endian. */
export function matchPda(matchId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(matchId);
  return pda([Buffer.from("match"), id]);
}

/** Read and decode a match account. Null if it does not exist. */
export async function fetchMatch(matchId: bigint): Promise<MatchAccount | null> {
  const info = await connection.getAccountInfo(matchPda(matchId));
  if (!info) return null;
  if (!info.owner.equals(programId)) {
    throw new Error("that match account is not owned by the escrow program");
  }
  // Decoded through the IDL rather than by hand, so a layout change in the
  // program shows up as a decode error instead of a plausible wrong number.
  const m = accounts.decode("Match", info.data) as Record<string, unknown>;
  const state = m.state as Record<string, unknown> | number;
  const stateName = typeof state === "number"
    ? STATES[state]
    : (STATES.find((s) => Object.prototype.hasOwnProperty.call(state, lower(s))) ?? "Open");
  return {
    matchId: BigInt(String(m.match_id ?? m.matchId)),
    stake: BigInt(String(m.stake)),
    maxPlayers: Number(m.max_players ?? m.maxPlayers),
    count: Number(m.count),
    players: (m.players as PublicKey[]).map((p) => new PublicKey(p)),
    state: stateName,
    joinDeadline: Number(m.join_deadline ?? m.joinDeadline),
    settleDeadline: Number(m.settle_deadline ?? m.settleDeadline),
    placements: Array.from(m.placements as number[]).map(Number),
    payouts: Array.from(m.payouts as unknown[]).map((v) => BigInt(String(v))),
    claimed: Number(m.claimed),
  };
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* -------------------------------------------------------- the actions --- */

export interface Planned {
  action: EscrowAction;
  matchId: bigint;
  /** Lamports leaving the wallet (join) or coming back to it (claim, refund). */
  lamports: bigint;
  /** Which way the money goes, for the sheet's wording. */
  direction: "pay" | "receive";
  /** A line of plain English for the sheet, from the chain's own numbers. */
  detail: string;
  build: (player: PublicKey) => TransactionInstruction;
}

/**
 * Decide whether an action is possible and what it is worth.
 *
 * Every refusal here is one the program would also make. Checking twice is
 * the point: a wallet prompt that is going to fail on chain still asks the
 * person to approve something, and the thing they are approving should at
 * least be real.
 */
export async function plan(
  action: EscrowAction, matchId: bigint, nowSeconds: number,
): Promise<Planned> {
  const m = await fetchMatch(matchId);
  if (!m) throw new Error(`no match ${matchId} on ${CHAIN}`);

  if (action === "join") {
    if (m.state !== "Open") throw new Error(`match ${matchId} is ${m.state.toLowerCase()}, not open`);
    if (nowSeconds > m.joinDeadline) throw new Error("the join window for that match has closed");
    if (m.count >= m.maxPlayers) throw new Error("that match is full");
    return {
      action,
      matchId,
      lamports: m.stake,
      direction: "pay",
      detail: `Seat ${m.count + 1} of ${m.maxPlayers}`,
      build: (player) => joinIx(player, matchId),
    };
  }

  // claim and refund are the same instruction: the program decides which it
  // is from the match state. They are separate actions here because what the
  // person is being asked to approve is different, and because this side can
  // tell them in advance when neither applies.
  if (action === "claim") {
    if (m.state !== "Settled") {
      throw new Error(`match ${matchId} is ${m.state.toLowerCase()}, so there is nothing to claim yet`);
    }
    return {
      action,
      matchId,
      // The slot, and therefore the payout, depend on which wallet signs, and
      // that is not known until the wallet authorises. The sheet shows the
      // range the match pays, and the exact figure lands on chain.
      lamports: m.payouts[0],
      direction: "receive",
      detail: `Pot pays ${fmt(m.payouts[0])}, ${fmt(m.payouts[1])}, ${fmt(m.payouts[2])} SOL`,
      build: (player) => claimIx(player, matchId),
    };
  }

  const refundable = m.state === "Refunding" ||
    (m.state === "Open" && nowSeconds > m.joinDeadline) ||
    (m.state === "Locked" && m.settleDeadline > 0 && nowSeconds > m.settleDeadline);
  if (!refundable) {
    throw new Error(
      `match ${matchId} is ${m.state.toLowerCase()} and its deadlines have not passed, ` +
      "so there is nothing to refund",
    );
  }
  return {
    action,
    matchId,
    lamports: m.stake,
    direction: "receive",
    detail: "Full stake back",
    build: (player) => claimIx(player, matchId),
  };
}

function fmt(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(4);
}

function joinIx(player: PublicKey, matchId: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: matchPda(matchId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructions.encode("join_match", {}),
  });
}

function claimIx(player: PublicKey, matchId: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: matchPda(matchId), isSigner: false, isWritable: true },
    ],
    data: instructions.encode("claim", {}),
  });
}

/** Wrap one instruction in a transaction the wallet can sign and send. */
export async function transactionFor(
  planned: Planned, player: PublicKey,
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: player,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(planned.build(player));
  return tx;
}
