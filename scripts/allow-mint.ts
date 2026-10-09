/**
 * Allow a mint for token pots in the escrow, or change its range. Run with
 * the admin key (the deployer), from a path outside this repository.
 *
 *   npx tsx scripts/allow-mint.ts --keypair ~/.config/solana/deployer.json \
 *     --mint <mint> --min 10 --max 1000 [--freeze-authority <key>] [--disable]
 *
 * --min and --max are whole tokens, turned into raw units with the decimals
 * read from the mint on chain. The program refuses a Token-2022 mint, and a
 * mint with a freeze authority unless --freeze-authority names exactly that
 * authority; this script checks both first so a mistake costs nothing.
 * Devnet by default, mainnet only with --mainnet.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { join } from "node:path";
import { CONFIG_PDA, PROGRAM_ID, accountsCoder, connect, instructions, parseArgs, run, str } from "./cluster";
import { TOKEN_PROGRAM, loadKeypair, readMint, toRaw } from "./spl";

const ROOT = join(__dirname, "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["keypair", "mint", "min", "max", "freeze-authority", "rpc"], ["mainnet", "disable"]);
  const keypairPath = str(args, "keypair");
  const mintArg = str(args, "mint");
  const minArg = str(args, "min");
  const maxArg = str(args, "max");
  if (!keypairPath || !mintArg || !minArg || !maxArg) throw new Error("--keypair, --mint, --min and --max are required");
  const admin = loadKeypair(keypairPath, ROOT);
  const mint = new PublicKey(mintArg);
  const freezeArg = str(args, "freeze-authority");
  const freeze = freezeArg ? new PublicKey(freezeArg) : null;

  const { connection, cluster } = await connect(args);
  const info = await readMint(connection, mint);
  if (!info.program.equals(TOKEN_PROGRAM)) throw new Error("not a classic SPL Token mint: the escrow refuses Token-2022");
  const actual = info.freezeAuthority?.toBase58() ?? null;
  if (actual !== (freeze?.toBase58() ?? null)) {
    throw new Error(`the mint's freeze authority is ${actual ?? "none"}; pass exactly that with --freeze-authority (or none)`);
  }
  const min = toRaw(minArg, info.decimals);
  const max = toRaw(maxArg, info.decimals);
  if (min === 0n || min > max) throw new Error("need 0 < min <= max");

  const [allow] = PublicKey.findProgramAddressSync([Buffer.from("mint"), mint.toBuffer()], PROGRAM_ID);
  const existing = await connection.getAccountInfo(allow);
  const enabled = args.get("disable") !== true;
  console.log(`cluster   ${cluster}`);
  console.log(`mint      ${mint.toBase58()} (${info.decimals} decimals)`);
  console.log(`range     ${min} to ${max} raw (${minArg} to ${maxArg} whole)`);
  console.log(`entry     ${allow.toBase58()} ${existing ? "exists, updating" : "new"}`);

  const data = existing
    ? instructions.encode("update_mint", {
        min_stake: new BN(min.toString()), max_stake: new BN(max.toString()), freeze_authority: freeze, enabled,
      })
    : instructions.encode("allow_mint", {
        min_stake: new BN(min.toString()), max_stake: new BN(max.toString()), freeze_authority: freeze,
      });
  const keys = existing
    ? [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: allow, isSigner: false, isWritable: true },
      ]
    : [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: allow, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(
    new TransactionInstruction({ programId: PROGRAM_ID, keys, data }),
  ), [admin], { commitment: "confirmed" });
  const after = await connection.getAccountInfo(allow);
  const decoded = after ? accountsCoder.decode("MintAllow", after.data) as Record<string, unknown> : null;
  console.log(`signature ${sig}`);
  console.log(`enabled   ${decoded?.enabled}`);
}

run(main);
