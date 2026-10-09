/**
 * Create a devnet test mint standing in for SKR, which does not exist on
 * devnet. Run on your own machine with the deployer key.
 *
 *   npx tsx scripts/create-test-skr.ts --keypair ~/.config/solana/deployer.json
 *
 * It reads the real SKR mint on mainnet first (--mainnet-rpc, default the
 * public mainnet RPC) and copies its decimals, so amounts on devnet mean the
 * same as they would on mainnet. Nothing about decimals is assumed. It also
 * prints the real mint's token program and freeze authority, which the
 * allowlist will have to account for on mainnet.
 *
 * The test mint is classic SPL Token, its mint authority is the key you pass
 * (so scripts/airdrop-test-skr.ts can mint to testers), and it has no freeze
 * authority. It refuses to run against mainnet. The keypair file is read
 * from the path given and must be outside this repository.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { join } from "node:path";
import { connect, parseArgs, run, str } from "./cluster";
import { MINT_SIZE, TOKEN_PROGRAM, initializeMint2Ix, loadKeypair, readMint } from "./spl";
import { SKR_MINT } from "../packages/shared/skr";

const ROOT = join(__dirname, "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["keypair", "rpc", "mainnet-rpc"], []);
  const keypairPath = str(args, "keypair");
  if (!keypairPath) throw new Error("--keypair is required (the deployer key, outside this repo)");
  const payer = loadKeypair(keypairPath, ROOT);

  const mainnet = new Connection(str(args, "mainnet-rpc") ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const real = await readMint(mainnet, new PublicKey(SKR_MINT));
  console.log(`mainnet SKR    ${SKR_MINT}`);
  console.log(`  program      ${real.program.toBase58()}${real.program.equals(TOKEN_PROGRAM) ? " (classic SPL Token)" : " (NOT classic SPL Token: the escrow would refuse it)"}`);
  console.log(`  decimals     ${real.decimals}`);
  console.log(`  freeze auth  ${real.freezeAuthority ? real.freezeAuthority.toBase58() : "none"}`);

  const { connection, cluster } = await connect(args);
  if (cluster !== "devnet") throw new Error(`refusing to create a test mint on ${cluster}: devnet only`);

  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM,
    }),
    initializeMint2Ix(mint.publicKey, real.decimals, payer.publicKey, null),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: "confirmed" });
  const made = await readMint(connection, mint.publicKey);
  console.log(`\ndevnet Test SKR ${mint.publicKey.toBase58()}`);
  console.log(`  decimals     ${made.decimals} (copied from mainnet)`);
  console.log(`  authority    ${payer.publicKey.toBase58()}`);
  console.log(`  signature    ${sig}`);
  console.log("\nNext: put this address in apps/mobile/src/config.ts as TEST_SKR_MINT and in");
  console.log("SKR_POT_MINT on the server, then");
  console.log("  npx tsx scripts/allow-mint.ts --keypair <admin> --mint <address> --min <whole> --max <whole>");
}

run(main);
