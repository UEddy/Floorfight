/**
 * Read the escrow program's config back. Takes no key and sends nothing.
 *
 *   npm run show-config
 *   npm run show-config -- --mainnet
 *   npm run show-config -- --rpc http://127.0.0.1:8899
 */
import {
  CONFIG_PDA, PROGRAM_ID, connect, parseArgs, printConfig, readConfig, run,
} from "./cluster";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["rpc"], ["mainnet"]);
  const { connection, cluster } = await connect(args);
  console.log(`cluster        ${cluster}`);
  console.log(`program        ${PROGRAM_ID.toBase58()}`);
  console.log(`config PDA     ${CONFIG_PDA.toBase58()}`);
  const config = await readConfig(connection);
  if (!config) {
    console.log("\nNo config account. Run scripts/init-config.ts first.");
    process.exit(2);
  }
  printConfig(config);
}

run(main);
