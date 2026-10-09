/**
 * The few SPL Token pieces the SKR scripts need, written out by hand so the
 * repo does not take on @solana/spl-token for three scripts: the classic
 * mint layout, and the InitializeMint2, MintTo and create idempotent ATA
 * instructions. Classic Token program only, the same as the escrow.
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VJS2ZkE9UQ53q7Jy6R7SGd5dKu2e");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MINT_SIZE = 82;

export interface MintInfo {
  program: PublicKey;
  decimals: number;
  supply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
}

/** Read a mint from the chain. Throws if it is not a token mint. */
export async function readMint(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`no account at ${mint.toBase58()}`);
  if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) {
    throw new Error(`${mint.toBase58()} is not owned by a token program`);
  }
  const d = info.data;
  if (d.length < MINT_SIZE || d[45] !== 1) throw new Error(`${mint.toBase58()} is not an initialised mint`);
  const opt = (at: number) => (d.readUInt32LE(at) === 1 ? new PublicKey(d.subarray(at + 4, at + 36)) : null);
  return {
    program: info.owner,
    mintAuthority: opt(0),
    supply: d.readBigUInt64LE(36),
    decimals: d[44],
    freezeAuthority: opt(46),
  };
}

export function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/** InitializeMint2 (instruction 20): no rent sysvar needed. */
export function initializeMint2Ix(mint: PublicKey, decimals: number, authority: PublicKey, freeze: PublicKey | null): TransactionInstruction {
  const data = Buffer.alloc(67);
  data[0] = 20;
  data[1] = decimals;
  authority.toBuffer().copy(data, 2);
  data[34] = freeze ? 1 : 0;
  if (freeze) freeze.toBuffer().copy(data, 35);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

/** Create an associated token account if it does not exist yet. */
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

/** MintTo (instruction 7). */
export function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Whole tokens (a decimal string like "12.5") to raw units, with the mint's decimals. */
export function toRaw(whole: string, decimals: number): bigint {
  if (!/^[0-9]{1,20}(\.[0-9]{1,18})?$/.test(whole)) throw new Error(`${whole} is not an amount`);
  const [i, f = ""] = whole.split(".");
  if (f.length > decimals) throw new Error(`${whole} has more decimal places than the mint's ${decimals}`);
  const raw = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (raw > 18_446_744_073_709_551_615n) throw new Error(`${whole} does not fit in a u64`);
  return raw;
}

/**
 * A keypair from a path you pass. Never a file in this repo: the scripts
 * refuse a path inside it, so a key cannot end up committed by accident.
 */
export function loadKeypair(path: string, repoRoot: string): Keypair {
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const full = resolve(expanded);
  if (full.startsWith(resolve(repoRoot) + "/")) {
    throw new Error(`${path} is inside the repository. Keep keys outside it.`);
  }
  const raw = JSON.parse(readFileSync(full, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${path} is not a Solana keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}
