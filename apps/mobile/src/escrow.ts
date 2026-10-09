/**
 * Transactions, built here.
 *
 * The page asks for an action on a match id. This file reads the match account
 * from the chain, works out for itself whether that action is possible and
 * what it is worth, and builds the instruction from the program IDL. The page
 * contributes a decimal number and nothing else.
 *
 * It follows that the amounts on the confirmation sheet are the chain's, not
 * the page's.
 *
 * Token pots work the same way. The page says "skr" and a tier; this file
 * maps that to config.TEST_SKR_MINT, reads the mint's decimals and its
 * allowlist entry off the chain, and builds the instructions with the
 * player's own associated token account as the only token account the
 * player side ever names. The vault is derived, never supplied. A page that wanted to show someone a stake of 0.01 and have
 * them sign away 10 would have to change the chain to do it.
 */

import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import idlJson from "./idl/arena.json";
import {
  CHAIN,
  HOLDERS_JOIN_WINDOW,
  HOLDERS_MAX_PLAYERS,
  PROGRAM_ID,
  RPC_URL,
  SKR_POT_LABEL,
  SKR_STAKE_TIERS,
  STAKE_TIERS,
  TEST_SKR_MINT,
} from "./config";
import type { Currency, EscrowAction } from "./bridge";

/** Classic SPL Token and the associated token account program. */
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** The real SKR mint, on mainnet. This build must never stake it. */
const MAINNET_SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
if (TEST_SKR_MINT === MAINNET_SKR_MINT) {
  throw new Error("TEST_SKR_MINT is the mainnet SKR mint. Token pots are devnet test pots only.");
}

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
  currency: Currency;
  /** The pot's mint for a token match; null for SOL. */
  mint: PublicKey | null;
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

/** TokenMatch PDA: seeds are "tmatch" and the u64 id, little endian. */
export function tokenMatchPda(matchId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(matchId);
  return pda([Buffer.from("tmatch"), id]);
}

/** A mint's allowlist entry: seeds are "mint" and the mint. */
export function allowPda(mint: PublicKey): PublicKey {
  return pda([Buffer.from("mint"), mint.toBuffer()]);
}

/** The associated token account of `owner` for `mint`, under classic SPL Token. */
export function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
  )[0];
}

/** Which escrow, and the id in it. Parsed from the bridge's checked string. */
export interface MatchRef {
  currency: Currency;
  id: bigint;
}

export function parseRef(matchId: string): MatchRef {
  const m = /^(skr-)?(0|[1-9][0-9]{0,19})$/.exec(matchId);
  if (!m) throw new Error("not a match id");
  const id = BigInt(m[2]);
  if (id > 18_446_744_073_709_551_615n) throw new Error("not a match id");
  return { currency: m[1] ? "skr" : "sol", id };
}

export function refKey(ref: MatchRef): string {
  return ref.currency === "sol" ? ref.id.toString() : `skr-${ref.id}`;
}

/** The token pot mint this build stakes in, or a refusal if it has none. */
export function testSkrMint(): PublicKey {
  if (!TEST_SKR_MINT) throw new Error(`${SKR_POT_LABEL} pots are not set up in this build`);
  return new PublicKey(TEST_SKR_MINT);
}

/**
 * Read and decode a match account. Null if it does not exist. A token match
 * in any mint but this build's TEST_SKR_MINT is refused: the sheet would have
 * to name a token this app does not know.
 */
export async function fetchMatch(ref: MatchRef | bigint): Promise<MatchAccount | null> {
  const r: MatchRef = typeof ref === "bigint" ? { currency: "sol", id: ref } : ref;
  const mintWanted = r.currency === "sol" ? null : testSkrMint();
  const info = await connection.getAccountInfo(r.currency === "sol" ? matchPda(r.id) : tokenMatchPda(r.id));
  if (!info) return null;
  if (!info.owner.equals(programId)) {
    throw new Error("that match account is not owned by the escrow program");
  }
  // Decoded through the IDL rather than by hand, so a layout change in the
  // program shows up as a decode error instead of a plausible wrong number.
  const m = accounts.decode(r.currency === "sol" ? "Match" : "TokenMatch", info.data) as Record<string, unknown>;
  const mint = r.currency === "sol" ? null : new PublicKey(m.mint as PublicKey);
  if (mintWanted && !mint!.equals(mintWanted)) {
    throw new Error(`that match is not a ${SKR_POT_LABEL} match`);
  }
  const state = m.state as Record<string, unknown> | number;
  const stateName = typeof state === "number"
    ? STATES[state]
    : (STATES.find((s) => Object.prototype.hasOwnProperty.call(state, lower(s))) ?? "Open");
  return {
    currency: r.currency,
    mint,
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
  action: EscrowAction | "create";
  matchId: bigint;
  currency: Currency;
  /** The match id as the page and the server write it: "skr-" for a token pot. */
  key: string;
  /**
   * What leaves the wallet (join) or comes back to it (claim, refund), in the
   * currency's smallest unit: lamports, or the mint's raw units.
   */
  amount: bigint;
  /** Of `amount`: 9 for SOL, the mint's own for a token pot, read from chain. */
  decimals: number;
  /** "SOL", or SKR_POT_LABEL. */
  unit: string;
  /** Which way the money goes, for the sheet's wording. */
  direction: "pay" | "receive";
  /** A line of plain English for the sheet, from the chain's own numbers. */
  detail: string;
  /** Every instruction the transaction will carry, in order. */
  build: (player: PublicKey) => TransactionInstruction[];
}

/* ------------------------------------------------------------- create --- */

/**
 * A random u64 match id, from the platform's secure random source.
 *
 * Random rather than counted because there is no counter to trust: two
 * phones creating at once must not collide, and the id is the PDA seed, so
 * a predictable one could be created first by somebody else. 2^64 makes a
 * collision a non-event; if one ever happens the create simply fails on chain
 * because the account exists, and nothing is lost.
 */
export function randomMatchId(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = 0n;
  for (const b of bytes) id = (id << 8n) | BigInt(b);
  return id;
}

/**
 * Plan a create: make a new match at a tier and take the first seat in it,
 * in one transaction, so a creator is never left with an empty match they
 * did not stake into.
 *
 * The tier is an index into this app's own list. The page never names an
 * amount, a player count or a window: those are this build's constants.
 */
export function planCreate(tier: number, matchId: bigint = randomMatchId()): Planned {
  const stake = STAKE_TIERS[tier];
  if (stake === undefined) throw new Error(`there is no stake tier ${tier}`);
  return {
    action: "create",
    matchId,
    currency: "sol",
    key: matchId.toString(),
    amount: stake,
    decimals: 9,
    unit: "SOL",
    direction: "pay",
    detail: `New match, ${HOLDERS_MAX_PLAYERS} seats, ${HOLDERS_JOIN_WINDOW / 60} minutes to fill`,
    build: (player) => [
      createMatchIx(player, matchId, stake),
      joinIx(player, matchId),
    ],
  };
}

/** What the chain says about the token pot mint: its decimals and its allowlist range. */
export interface TokenPot {
  mint: PublicKey;
  decimals: number;
  minStake: bigint;
  maxStake: bigint;
}

/**
 * Read the pot mint and its allowlist entry. The decimals come from the mint
 * account itself (a classic SPL Token mint, 82 bytes, decimals at byte 44),
 * so they are never assumed; the range and whether new matches are allowed
 * at all come from the program's own allowlist account.
 */
export async function readTokenPot(mint: PublicKey = testSkrMint()): Promise<TokenPot> {
  const [mintInfo, allowInfo] = await Promise.all([
    connection.getAccountInfo(mint),
    connection.getAccountInfo(allowPda(mint)),
  ]);
  if (!mintInfo) throw new Error(`the ${SKR_POT_LABEL} mint does not exist on ${CHAIN}`);
  if (!mintInfo.owner.equals(TOKEN_PROGRAM) || mintInfo.data.length !== 82) {
    throw new Error(`the ${SKR_POT_LABEL} mint is not a classic SPL Token mint`);
  }
  const decimals = mintInfo.data[44];
  if (decimals > 18) throw new Error("the mint claims more decimals than this app will show");
  if (!allowInfo || !allowInfo.owner.equals(programId)) {
    throw new Error(`${SKR_POT_LABEL} is not on the escrow's allowlist`);
  }
  const a = accounts.decode("MintAllow", allowInfo.data) as Record<string, unknown>;
  if (!a.enabled) throw new Error(`${SKR_POT_LABEL} pots are turned off for new matches`);
  return {
    mint,
    decimals,
    minStake: BigInt(String(a.min_stake ?? a.minStake)),
    maxStake: BigInt(String(a.max_stake ?? a.maxStake)),
  };
}

/** Whole tokens to raw units, integers only. */
export function wholeToRaw(whole: bigint, decimals: number): bigint {
  if (whole < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("bad token amount");
  }
  const raw = whole * 10n ** BigInt(decimals);
  if (raw > 18_446_744_073_709_551_615n) throw new Error("stake does not fit a u64");
  return raw;
}

/**
 * Plan a token pot create: the same as planCreate, with the stake in whole
 * tokens from this build's list, turned into raw units with the decimals the
 * mint reports. Refused here, before the wallet opens, if the allowlist's
 * range would refuse it on chain.
 */
export async function planCreateToken(
  tier: number, matchId: bigint = randomMatchId(), pot?: TokenPot,
): Promise<Planned> {
  const whole = SKR_STAKE_TIERS[tier];
  if (whole === undefined) throw new Error(`there is no ${SKR_POT_LABEL} tier ${tier}`);
  const p = pot ?? await readTokenPot();
  const stake = wholeToRaw(whole, p.decimals);
  if (stake < p.minStake || stake > p.maxStake) {
    throw new Error(`a stake of ${whole} is outside what the allowlist accepts for ${SKR_POT_LABEL}`);
  }
  return {
    action: "create",
    matchId,
    currency: "skr",
    key: `skr-${matchId}`,
    amount: stake,
    decimals: p.decimals,
    unit: SKR_POT_LABEL,
    direction: "pay",
    detail: `New ${SKR_POT_LABEL} match, ${HOLDERS_MAX_PLAYERS} seats, ${HOLDERS_JOIN_WINDOW / 60} minutes to fill`,
    build: (player) => [
      createTokenMatchIx(player, p.mint, matchId, stake),
      joinTokenIx(player, p.mint, matchId),
    ],
  };
}

export function createMatchIx(creator: PublicKey, matchId: bigint, stake: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: matchPda(matchId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructions.encode("create_match", {
      match_id: new BN(matchId.toString()),
      stake: new BN(stake.toString()),
      max_players: HOLDERS_MAX_PLAYERS,
      join_window: new BN(HOLDERS_JOIN_WINDOW),
    }),
  });
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
  action: EscrowAction, ref: MatchRef | bigint, nowSeconds: number, wallet: string | null = null,
): Promise<Planned> {
  const r: MatchRef = typeof ref === "bigint" ? { currency: "sol", id: ref } : ref;
  const matchId = r.id;
  const key = refKey(r);
  const m = await fetchMatch(r);
  if (!m) throw new Error(`no match ${key} on ${CHAIN}`);
  const token = m.mint;
  const decimals = token ? (await readTokenPotDecimals(token)) : 9;
  const unit = token ? SKR_POT_LABEL : "SOL";
  const money = { matchId, currency: r.currency, key, decimals, unit };
  // The player's token account is always their own associated token account
  // for the match's mint: derived here, never named by the page.
  const joinBuild = (player: PublicKey) => token ? [joinTokenIx(player, token, matchId)] : [joinIx(player, matchId)];
  const claimBuild = (player: PublicKey) => token
    ? [createAtaIdempotentIx(player, player, token), claimTokenIx(player, token, matchId)]
    : [claimIx(player, matchId)];

  if (action === "join") {
    if (m.state !== "Open") throw new Error(`match ${matchId} is ${m.state.toLowerCase()}, not open`);
    if (nowSeconds > m.joinDeadline) throw new Error("the join window for that match has closed");
    if (m.count >= m.maxPlayers) throw new Error("that match is full");
    return {
      action,
      ...money,
      amount: m.stake,
      direction: "pay",
      detail: `Seat ${m.count + 1} of ${m.maxPlayers}`,
      build: joinBuild,
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
    // With a connected wallet the exact payout is known: its slot, then that
    // slot's place. Without one, the sheet shows what the match pays and the
    // exact figure lands on chain.
    const slot = wallet === null ? -1 : m.players.slice(0, m.count).findIndex((p) => p.toBase58() === wallet);
    const place = slot < 0 ? -1 : m.placements.indexOf(slot);
    if (wallet !== null && slot >= 0 && place < 0) {
      throw new Error("this wallet did not place in that match, so it has no payout to claim");
    }
    if (place >= 0 && (m.claimed & (1 << slot)) !== 0) {
      throw new Error("this wallet has already claimed its payout");
    }
    return {
      action,
      ...money,
      amount: place >= 0 ? m.payouts[place] : m.payouts[0],
      direction: "receive",
      detail: place >= 0
        ? `Place ${place + 1} of ${m.count}`
        : `Pot pays ${formatUnits(m.payouts[0], decimals)}, ${formatUnits(m.payouts[1], decimals)}, ` +
          `${formatUnits(m.payouts[2], decimals)} ${unit}`,
      build: claimBuild,
    };
  }

  const refundable = m.state === "Refunding" ||
    (m.state === "Open" && nowSeconds > m.joinDeadline) ||
    (m.state === "Locked" && m.settleDeadline > 0 && nowSeconds > m.settleDeadline);
  if (!refundable) {
    throw new Error(
      `match ${key} is ${m.state.toLowerCase()} and its deadlines have not passed, ` +
      "so there is nothing to refund",
    );
  }
  return {
    action,
    ...money,
    amount: m.stake,
    direction: "receive",
    detail: "Full stake back",
    build: claimBuild,
  };
}

/** Decimals of a token match's mint, from the mint account. */
async function readTokenPotDecimals(mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint);
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 82) {
    throw new Error(`the ${SKR_POT_LABEL} mint could not be read`);
  }
  const d = info.data[44];
  if (d > 18) throw new Error("the mint claims more decimals than this app will show");
  return d;
}

/**
 * An amount in its smallest unit as a decimal string, in integers only so
 * no amount is ever rounded on the sheet: 1234500000 at 9 decimals is
 * "1.2345". Trailing zeros go, and a whole amount has no point.
 */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function joinIx(player: PublicKey, matchId: bigint): TransactionInstruction {
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

export function claimIx(player: PublicKey, matchId: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: matchPda(matchId), isSigner: false, isWritable: true },
    ],
    data: instructions.encode("claim", {}),
  });
}

/* -------------------------------------------------------- token pots --- */

export function createTokenMatchIx(
  creator: PublicKey, mint: PublicKey, matchId: bigint, stake: bigint,
): TransactionInstruction {
  const m = tokenMatchPda(matchId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: allowPda(mint), isSigner: false, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: ataOf(m, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructions.encode("create_token_match", {
      match_id: new BN(matchId.toString()),
      stake: new BN(stake.toString()),
      max_players: HOLDERS_MAX_PLAYERS,
      join_window: new BN(HOLDERS_JOIN_WINDOW),
    }),
  });
}

/** Stake from the player's own associated token account into the match's vault. */
export function joinTokenIx(player: PublicKey, mint: PublicKey, matchId: bigint): TransactionInstruction {
  const m = tokenMatchPda(matchId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ataOf(m, mint), isSigner: false, isWritable: true },
      { pubkey: ataOf(player, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: instructions.encode("join_token_match", {}),
  });
}

/** Pay out (or refund) into the player's own associated token account. */
export function claimTokenIx(player: PublicKey, mint: PublicKey, matchId: bigint): TransactionInstruction {
  const m = tokenMatchPda(matchId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ataOf(m, mint), isSigner: false, isWritable: true },
      { pubkey: ataOf(player, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: instructions.encode("claim_token", {}),
  });
}

/**
 * Create the player's associated token account if it does not exist yet, and
 * do nothing if it does (CreateIdempotent, instruction 1 of the ATA program).
 * Put in front of a claim, so a winner who has since closed their account
 * still gets paid. The player pays its rent, and it is their account.
 */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
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
  tx.add(...planned.build(player));
  return tx;
}
