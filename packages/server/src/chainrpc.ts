/**
 * The half of the chain that needs a network and a key.
 *
 * Nothing imports this unless a resolver is configured: index.ts loads it
 * dynamically when the environment names one. A free only server, which is
 * what a laptop and a play-testing droplet are, never pays for
 * @solana/web3.js at all.
 *
 * Two rules out of CLAUDE.md are enforced here rather than written down and
 * hoped for:
 *
 *   - The resolver key file must not be readable by group or others. A key
 *     the rest of the box can read is a key that has already leaked, and the
 *     server refuses to start rather than pretend otherwise.
 *   - Dev mode and the resolver key must never be on the same machine. The
 *     dev roster keys are public, so a box with both is a box where anyone
 *     can join a room on the machine that signs payouts.
 */

import { readFileSync, statSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  IDL_ADDRESS,
  decodeMatch,
  decodeTokenMatch,
  lockData,
  matchKey,
  mintDecimals,
  openMatchFilters,
  openTokenMatchFilters,
  settleData,
  type MatchAccount,
  type MatchRef,
} from "./chain";
import { SKR_MINT } from "../../shared/skr";
import type { Currency } from "../../shared/tiers";

export { hasChainEnv } from "./chain";

export interface ChainConfig {
  connection: Connection;
  programId: PublicKey;
  resolver: Keypair;
  rpcUrl: string;
  /**
   * The one mint this server hosts token matches for (SKR_POT_MINT), or null
   * for SOL matches only. A token match in any other mint is, to this server,
   * not there: it is not listed, its room does not open and it is not settled.
   */
  potMint: PublicKey | null;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ------------------------------------------------------------- config --- */

/**
 * Refuse to carry on if anyone but the owner can read the key file.
 *
 * Checked by mode rather than by trying to read it as another user, because
 * the service runs as its own user and the failure to catch is a key copied
 * in with a default umask.
 */
export function assertKeyFilePrivate(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `resolver key ${path} is mode ${mode.toString(8)}: readable by group or others. ` +
      "Run chmod 600 on it. Refusing to start.",
    );
  }
}

/** Load a Solana CLI keypair file: a JSON array of 64 bytes. */
export function loadResolver(path: string): Keypair {
  assertKeyFilePrivate(path);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`resolver key ${path} is not a 64 byte keypair array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/**
 * Read the chain configuration out of the environment.
 *
 * Returns null when it is absent, which means free rooms only. Throws when it
 * is present but wrong, because a half configured staked server is worse than
 * one that will not start: it would take stakes with no way to pay them out.
 */
export function chainFromEnv(env: NodeJS.ProcessEnv, devMode: boolean): ChainConfig | null {
  const rpcUrl = env.RPC_URL;
  const programId = env.PROGRAM_ID;
  const keyPath = env.RESOLVER_KEYPAIR_PATH;

  const potMint = env.SKR_POT_MINT || null;

  const given = [rpcUrl, programId, keyPath].filter((v) => v !== undefined && v !== "");
  if (given.length === 0) {
    if (potMint) {
      throw new Error("SKR_POT_MINT is set but there is no chain configuration to settle token matches with");
    }
    return null;
  }
  if (given.length !== 3) {
    throw new Error(
      "RPC_URL, PROGRAM_ID and RESOLVER_KEYPAIR_PATH have to be set together. " +
      "Staked rooms need all three: an endpoint to read the roster from, the " +
      "program that holds the escrow, and the key that signs the payout.",
    );
  }
  if (devMode) {
    throw new Error(
      "ARENA_DEV is set and a resolver key is configured. The dev roster keys " +
      "are public, so this would be a machine where anyone can join a room on " +
      "the box that signs payouts. Refusing to start.",
    );
  }
  // The IDL in the repo has to be for the program being talked to: the
  // discriminators come from it, and a stale copy would produce instructions
  // the program rejects for reasons that look like anything but a stale file.
  if (IDL_ADDRESS !== programId) {
    throw new Error(
      `PROGRAM_ID is ${programId} but idl/arena.json is for ${IDL_ADDRESS}. ` +
      "Run npm run idl:sync at the repo root after rebuilding the program.",
    );
  }

  if (potMint !== null) {
    if (!BASE58_RE.test(potMint)) throw new Error("SKR_POT_MINT is not a base58 address");
    // Token pots are a devnet test for now, labelled "Test SKR (devnet)"
    // everywhere a person sees them. Staking the real token is the dApp
    // Store question in CLAUDE.md and is not decided, so the server refuses
    // to be pointed at it rather than relying on nobody trying.
    if (potMint === SKR_MINT) {
      throw new Error(
        "SKR_POT_MINT is the mainnet SKR mint. Token pots run on a devnet test mint " +
        "until real money staking is decided. Refusing to start.",
      );
    }
  }

  return {
    connection: new Connection(rpcUrl!, "confirmed"),
    programId: new PublicKey(programId!),
    resolver: loadResolver(keyPath!),
    rpcUrl: rpcUrl!,
    potMint: potMint === null ? null : new PublicKey(potMint),
  };
}

/* ---------------------------------------------------------- accounts --- */

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

/** Match PDA: seeds are "match" and the u64 id, little endian. */
export function matchPda(programId: PublicKey, matchId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(matchId);
  return PublicKey.findProgramAddressSync([Buffer.from("match"), id], programId)[0];
}

/** TokenMatch PDA: seeds are "tmatch" and the u64 id, little endian. */
export function tokenMatchPda(programId: PublicKey, matchId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(matchId);
  return PublicKey.findProgramAddressSync([Buffer.from("tmatch"), id], programId)[0];
}

/** The account a match ref names. */
export function refPda(programId: PublicKey, ref: MatchRef): PublicKey {
  return ref.currency === "sol" ? matchPda(programId, ref.id) : tokenMatchPda(programId, ref.id);
}

/**
 * Read a match. Null when there is no such account, and also, for a token
 * match, when its mint is not this server's SKR_POT_MINT (or the server has
 * none): those are matches this server does not host.
 */
export async function fetchMatch(
  chain: ChainConfig, ref: MatchRef,
): Promise<MatchAccount | null> {
  if (ref.currency !== "sol" && !chain.potMint) return null;
  const info = await chain.connection.getAccountInfo(refPda(chain.programId, ref));
  if (!info) return null;
  if (!info.owner.equals(chain.programId)) {
    throw new Error(`match ${matchKey(ref)} is not owned by ${chain.programId.toBase58()}`);
  }
  if (ref.currency === "sol") return decodeMatch(info.data);
  const m = decodeTokenMatch(info.data);
  if (m.matchId !== ref.id) throw new Error(`match ${matchKey(ref)} holds id ${m.matchId}`);
  return m.mint === chain.potMint!.toBase58() ? m : null;
}

/**
 * Decimals of the pot mint, read once from the chain and kept: a mint's
 * decimals cannot change after it is initialized.
 */
let potDecimals: Promise<number> | null = null;
export function potMintDecimals(chain: ChainConfig): Promise<number> {
  if (!chain.potMint) return Promise.reject(new Error("no token pot mint configured"));
  potDecimals ??= (async () => {
    const info = await chain.connection.getAccountInfo(chain.potMint!);
    if (!info) throw new Error("SKR_POT_MINT does not exist on this cluster");
    if (info.owner.toBase58() !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      throw new Error("SKR_POT_MINT is not a classic SPL Token mint");
    }
    return mintDecimals(info.data);
  })().catch((e) => { potDecimals = null; throw e; });
  return potDecimals;
}

/* ----------------------------------------------------------- settling --- */

/**
 * settle, or settle_token_match. Both take the same three accounts in the
 * same order (resolver, config, the match) and the same two arguments; a
 * token settle moves no tokens, it only records who is owed what, and each
 * winner pulls their share with claim_token.
 */
export function settleInstruction(
  chain: ChainConfig, ref: MatchRef, placements: number[], logHash: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: chain.programId,
    keys: [
      { pubkey: chain.resolver.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(chain.programId), isSigner: false, isWritable: false },
      { pubkey: refPda(chain.programId, ref), isSigner: false, isWritable: true },
    ],
    data: settleData(placements, logHash, ref.currency),
  });
}

/**
 * Submit a settlement, retrying with backoff.
 *
 * Worth the retries: the resolver has until the settle deadline on chain, and
 * the alternative to trying again is a match that refunds everybody because
 * one RPC call timed out. It stops early when the account says the work is
 * already done, which covers a transaction that landed while its reply was
 * being lost, and gives up immediately on a state that can never be settled.
 */
export async function settleWithRetry(
  chain: ChainConfig,
  ref: MatchRef,
  placements: number[],
  logHash: Uint8Array,
  attempts = 12,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string | null> {
  const matchId = matchKey(ref);
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // 2s, 4s, 8s and so on, capped at a minute. Twelve attempts is about
      // ten minutes, well inside the shortest settle window the program will
      // accept.
      await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    }
    try {
      const current = await fetchMatch(chain, ref);
      if (!current) throw new Error("match account has gone");
      if (current.state === "Settled") {
        console.log(`[match ${matchId}] already settled on chain`);
        return null;
      }
      if (current.state !== "Locked") {
        throw new Error(`match is ${current.state}, which cannot be settled`);
      }

      const tx = new Transaction().add(
        settleInstruction(chain, ref, placements, logHash),
      );
      const sig = await chain.connection.sendTransaction(tx, [chain.resolver], {
        skipPreflight: false,
        maxRetries: 3,
      });
      await chain.connection.confirmTransaction(sig, "confirmed");
      console.log(`[match ${matchId}] settled, ${sig}`);
      return sig;
    } catch (e) {
      lastError = (e as Error).message;
      const fatal = lastError.includes("cannot be settled") ||
        lastError.includes("account has gone");
      console.error(
        `[match ${matchId}] settle attempt ${attempt + 1}/${attempts} failed: ${lastError}`,
      );
      if (fatal) break;
    }
  }
  throw new Error(`could not settle match ${matchId}: ${lastError}`);
}

/* ------------------------------------------------------------ locking --- */

export function lockInstruction(chain: ChainConfig, ref: MatchRef): TransactionInstruction {
  return new TransactionInstruction({
    programId: chain.programId,
    keys: [
      { pubkey: chain.resolver.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(chain.programId), isSigner: false, isWritable: false },
      { pubkey: refPda(chain.programId, ref), isSigner: false, isWritable: true },
    ],
    data: lockData(ref.currency),
  });
}

/**
 * Lock a match the lobby has decided is ready. One attempt: the lobby polls
 * again a few seconds later and decides afresh from the account, which is
 * the right retry because the account may have changed (filled and locked
 * itself, or passed its deadline) in between.
 */
export async function lockMatch(chain: ChainConfig, ref: MatchRef): Promise<string> {
  const tx = new Transaction().add(lockInstruction(chain, ref));
  const sig = await chain.connection.sendTransaction(tx, [chain.resolver], {
    skipPreflight: false,
    maxRetries: 3,
  });
  await chain.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/* ------------------------------------------------------------ listing --- */

/**
 * Open matches at one stake in one currency, straight from the program's
 * accounts. Token matches are only ever those in SKR_POT_MINT.
 */
export async function listOpenMatches(
  chain: ChainConfig, currency: Currency, stake: bigint,
): Promise<{ address: string; account: MatchAccount }[]> {
  if (currency !== "sol" && !chain.potMint) return [];
  const f = currency === "sol"
    ? openMatchFilters(stake)
    : openTokenMatchFilters(chain.potMint!.toBase58(), stake);
  const decode = currency === "sol" ? decodeMatch : decodeTokenMatch;
  const found = await chain.connection.getProgramAccounts(chain.programId, {
    commitment: "confirmed",
    filters: [{ dataSize: f.dataSize }, ...f.memcmp.map((memcmp) => ({ memcmp }))],
  });
  const out: { address: string; account: MatchAccount }[] = [];
  for (const { pubkey, account } of found) {
    try {
      out.push({ address: pubkey.toBase58(), account: decode(account.data) });
    } catch {
      // Not a Match after all. The filters make this unlikely; the decoder
      // checking the discriminator makes it harmless.
    }
  }
  return out;
}
