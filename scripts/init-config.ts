/**
 * Initialise the escrow program's config. Run once per deployment, on your
 * own machine, with the deployer key.
 *
 *   npm run init-config -- \
 *     --keypair ~/.config/solana/deployer.json \
 *     --resolver <resolver public key> \
 *     --min-stake 10000000 --max-stake 100000000 \
 *     --settle-window 900
 *
 * Devnet by default. Mainnet is refused unless --mainnet is passed, and --rpc
 * overrides the URL either way (the cluster is still checked by genesis hash).
 *
 * --keypair must be the program's upgrade authority: initialize_config checks
 * it against the program data account so nobody can front-run the deployment
 * and install themselves as admin. That key becomes the admin. The resolver
 * is a different key, given here by its public key only: its secret lives on
 * the droplet and never needs to be on this machine.
 *
 * Nothing secret is printed. The keypair file is read, used to sign one
 * transaction, and dropped.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  CONFIG_PDA,
  MAX_SETTLE_WINDOW,
  MIN_SETTLE_WINDOW,
  PROGRAM_ID,
  connect,
  instructions,
  parseArgs,
  printConfig,
  readConfig,
  run,
  sol,
  str,
} from "./cluster";

const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** The stake tiers the app offers on devnet, in lamports. Kept in step with apps/mobile/src/config.ts. */
const DEVNET_TIERS = [10_000_000n, 50_000_000n, 100_000_000n];

function lamports(args: Map<string, string | true>, name: string): bigint {
  const v = str(args, name);
  if (v === undefined) throw new Error(`--${name} is required (lamports)`);
  if (!/^[0-9]{1,20}$/.test(v)) throw new Error(`--${name} must be a whole number of lamports`);
  const n = BigInt(v);
  if (n > 18_446_744_073_709_551_615n) throw new Error(`--${name} does not fit in a u64`);
  return n;
}

function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const raw = JSON.parse(readFileSync(expanded, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`${path} is not a Solana keypair file (a JSON array of 64 numbers)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

async function main(): Promise<void> {
  const args = parseArgs(
    process.argv.slice(2),
    ["keypair", "resolver", "min-stake", "max-stake", "settle-window", "rpc"],
    ["mainnet"],
  );

  const keypairPath = str(args, "keypair");
  if (!keypairPath) throw new Error("--keypair is required (the program's upgrade authority)");
  const resolverArg = str(args, "resolver");
  if (!resolverArg) throw new Error("--resolver is required (a public key)");
  let resolver: PublicKey;
  try {
    resolver = new PublicKey(resolverArg);
  } catch {
    throw new Error("--resolver is not a valid public key");
  }
  const minStake = lamports(args, "min-stake");
  const maxStake = lamports(args, "max-stake");
  const windowArg = str(args, "settle-window");
  if (!windowArg || !/^[0-9]{1,6}$/.test(windowArg)) {
    throw new Error("--settle-window is required (whole seconds)");
  }
  const settleWindow = Number(windowArg);

  // The program checks all of these too. Checking here means a typo costs
  // nothing rather than a failed transaction's fee.
  const admin = loadKeypair(keypairPath);
  if (resolver.equals(admin.publicKey)) {
    throw new Error("the resolver must be a different key from the admin (the deployer)");
  }
  if (minStake === 0n || minStake > maxStake) {
    throw new Error("need 0 < min-stake <= max-stake");
  }
  if (settleWindow < MIN_SETTLE_WINDOW || settleWindow > MAX_SETTLE_WINDOW) {
    throw new Error(`--settle-window must be ${MIN_SETTLE_WINDOW} to ${MAX_SETTLE_WINDOW} seconds`);
  }

  const { connection, cluster } = await connect(args);
  console.log(`cluster        ${cluster}`);
  console.log(`program        ${PROGRAM_ID.toBase58()}`);
  console.log(`config PDA     ${CONFIG_PDA.toBase58()}`);
  console.log(`admin          ${admin.publicKey.toBase58()}`);

  if (cluster === "devnet") {
    const outside = DEVNET_TIERS.filter((t) => t < minStake || t > maxStake);
    if (outside.length) {
      console.warn(
        `warning: the app's devnet tiers ${outside.map(sol).join(", ")} SOL fall outside ` +
        `${sol(minStake)} to ${sol(maxStake)} SOL, so creating a match at those tiers will fail`,
      );
    }
  }

  const existing = await readConfig(connection);
  if (existing) {
    console.log("\nThe config is already initialised. It holds:");
    printConfig(existing);
    console.log("\nNothing was sent. Changing it is update_config, by the admin.");
    return;
  }

  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_V3);
  const data = instructions.encode("initialize_config", {
    resolver,
    min_stake: new BN(minStake.toString()),
    max_stake: new BN(maxStake.toString()),
    settle_window: new BN(settleWindow),
  });
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const signature = await sendAndConfirmTransaction(
    connection, new Transaction().add(ix), [admin], { commitment: "confirmed" },
  );
  console.log(`signature      ${signature}`);

  const written = await readConfig(connection);
  if (!written) throw new Error("the transaction confirmed but the config account is not there");
  console.log("\nThe config now holds:");
  printConfig(written);
}

run(main);
