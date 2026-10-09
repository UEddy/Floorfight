/**
 * Mint devnet Test SKR to a tester's wallet. Devnet only, with the test
 * mint's authority key from a path outside this repository.
 *
 *   npx tsx scripts/airdrop-test-skr.ts --keypair ~/.config/solana/deployer.json \
 *     --mint <test mint> --to <wallet> --amount 500
 *
 * --amount is whole tokens; the mint's decimals are read from the chain.
 * Creates the wallet's associated token account if it has none.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { join } from "node:path";
import { connect, parseArgs, run, str } from "./cluster";
import { TOKEN_PROGRAM, ataOf, createAtaIdempotentIx, loadKeypair, mintToIx, readMint, toRaw } from "./spl";
import { SKR_MINT } from "../packages/shared/skr";

const ROOT = join(__dirname, "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["keypair", "mint", "to", "amount", "rpc"], []);
  const keypairPath = str(args, "keypair");
  const mintArg = str(args, "mint");
  const toArg = str(args, "to");
  const amountArg = str(args, "amount");
  if (!keypairPath || !mintArg || !toArg || !amountArg) {
    throw new Error("--keypair, --mint, --to and --amount are all required");
  }
  if (mintArg === SKR_MINT) throw new Error("that is the real SKR mint. This script only mints devnet Test SKR.");
  const authority = loadKeypair(keypairPath, ROOT);
  const mint = new PublicKey(mintArg);
  const to = new PublicKey(toArg);

  const { connection, cluster } = await connect(args);
  if (cluster !== "devnet") throw new Error(`refusing to mint on ${cluster}: devnet only`);
  const info = await readMint(connection, mint);
  if (!info.program.equals(TOKEN_PROGRAM)) throw new Error("not a classic SPL Token mint");
  if (!info.mintAuthority?.equals(authority.publicKey)) throw new Error("that key is not this mint's authority");
  const raw = toRaw(amountArg, info.decimals);

  const ata = ataOf(to, mint);
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(
    createAtaIdempotentIx(authority.publicKey, to, mint),
    mintToIx(mint, ata, authority.publicKey, raw),
  ), [authority], { commitment: "confirmed" });
  console.log(`minted ${amountArg} Test SKR (${raw} raw, ${info.decimals} decimals) to ${to.toBase58()}`);
  console.log(`token account ${ata.toBase58()}`);
  console.log(`signature     ${sig}`);
}

run(main);
