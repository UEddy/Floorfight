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
  lockData,
  openMatchFilters,
  settleData,
  type MatchAccount,
} from "./chain";

export { hasChainEnv } from "./chain";

export interface ChainConfig {
  connection: Connection;
  programId: PublicKey;
  resolver: Keypair;
  rpcUrl: string;
}

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

  const given = [rpcUrl, programId, keyPath].filter((v) => v !== undefined && v !== "");
  if (given.length === 0) return null;
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

  return {
    connection: new Connection(rpcUrl!, "confirmed"),
    programId: new PublicKey(programId!),
    resolver: loadResolver(keyPath!),
    rpcUrl: rpcUrl!,
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

export async function fetchMatch(
  chain: ChainConfig, matchId: bigint,
): Promise<MatchAccount | null> {
  const info = await chain.connection.getAccountInfo(matchPda(chain.programId, matchId));
  if (!info) return null;
  if (!info.owner.equals(chain.programId)) {
    throw new Error(`match ${matchId} is not owned by ${chain.programId.toBase58()}`);
  }
  return decodeMatch(info.data);
}

/* ----------------------------------------------------------- settling --- */

export function settleInstruction(
  chain: ChainConfig, matchId: bigint, placements: number[], logHash: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: chain.programId,
    keys: [
      { pubkey: chain.resolver.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(chain.programId), isSigner: false, isWritable: false },
      { pubkey: matchPda(chain.programId, matchId), isSigner: false, isWritable: true },
    ],
    data: settleData(placements, logHash),
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
  matchId: bigint,
  placements: number[],
  logHash: Uint8Array,
  attempts = 12,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string | null> {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // 2s, 4s, 8s and so on, capped at a minute. Twelve attempts is about
      // ten minutes, well inside the shortest settle window the program will
      // accept.
      await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    }
    try {
      const current = await fetchMatch(chain, matchId);
      if (!current) throw new Error("match account has gone");
      if (current.state === "Settled") {
        console.log(`[match ${matchId}] already settled on chain`);
        return null;
      }
      if (current.state !== "Locked") {
        throw new Error(`match is ${current.state}, which cannot be settled`);
      }

      const tx = new Transaction().add(
        settleInstruction(chain, matchId, placements, logHash),
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

export function lockInstruction(chain: ChainConfig, matchId: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: chain.programId,
    keys: [
      { pubkey: chain.resolver.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda(chain.programId), isSigner: false, isWritable: false },
      { pubkey: matchPda(chain.programId, matchId), isSigner: false, isWritable: true },
    ],
    data: lockData(),
  });
}

/**
 * Lock a match the lobby has decided is ready. One attempt: the lobby polls
 * again a few seconds later and decides afresh from the account, which is
 * the right retry because the account may have changed (filled and locked
 * itself, or passed its deadline) in between.
 */
export async function lockMatch(chain: ChainConfig, matchId: bigint): Promise<string> {
  const tx = new Transaction().add(lockInstruction(chain, matchId));
  const sig = await chain.connection.sendTransaction(tx, [chain.resolver], {
    skipPreflight: false,
    maxRetries: 3,
  });
  await chain.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/* ------------------------------------------------------------ listing --- */

/** Open matches at one stake, straight from the program's accounts. */
export async function listOpenMatches(
  chain: ChainConfig, stake: bigint,
): Promise<{ address: string; account: MatchAccount }[]> {
  const f = openMatchFilters(stake);
  const found = await chain.connection.getProgramAccounts(chain.programId, {
    commitment: "confirmed",
    filters: [{ dataSize: f.dataSize }, ...f.memcmp.map((memcmp) => ({ memcmp }))],
  });
  const out: { address: string; account: MatchAccount }[] = [];
  for (const { pubkey, account } of found) {
    try {
      out.push({ address: pubkey.toBase58(), account: decodeMatch(account.data) });
    } catch {
      // Not a Match after all. The filters make this unlikely; the decoder
      // checking the discriminator makes it harmless.
    }
  }
  return out;
}
