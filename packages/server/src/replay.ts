/**
 * Replay a match log and check it.
 *
 * This is the thing the audit story is about. The server publishes the log it
 * hashed and writes that hash on chain with the payout; anyone can take the
 * log, re-run the simulation over it, and see whether the result the money
 * went to is the result the inputs produce.
 *
 *   npm run replay -- https://floorfight.duckdns.org/logs/12345.json
 *   npm run replay -- /var/lib/floorfight/logs/12345.json --rpc https://api.devnet.solana.com
 *
 * It checks four things, in order of how much they would matter if they
 * failed:
 *
 *   1. The file is exactly the canonical form of the log it contains, so the
 *      hash of the bytes is the hash of the match.
 *   2. The map it was played on is the map this build has. A different map is
 *      different geometry and a different outcome; there is no point
 *      replaying it with the wrong one.
 *   3. Re-running sim.step over the recorded inputs reproduces the recorded
 *      standings, using the shared ordering rule rather than its own.
 *   4. The hash of those bytes is the hash the escrow account was settled
 *      with, if an RPC endpoint was given.
 *
 * It takes no key and writes nothing. Being able to run it against somebody
 * else's match from a laptop is the point.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MAP_ID,
  createWorld,
  step,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { saltSeeds } from "../../shared/weapons";
import { fromHex } from "../../shared/sha256";
import {
  LOG_VERSION,
  canonicalise,
  decanonicalise,
  standingsFrom,
  type MatchLog,
} from "../../shared/protocol";

interface Options {
  source: string;
  rpcUrl?: string;
  programId?: string;
}

function parseArgs(argv: string[]): Options {
  const rest = argv.slice(2);
  const source = rest.find((a) => !a.startsWith("--"));
  if (!source) {
    throw new Error(
      "usage: npm run replay -- <url or path> [--rpc <url>] [--program <id>]",
    );
  }
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  return {
    source,
    rpcUrl: flag("rpc") ?? process.env.RPC_URL,
    programId: flag("program") ?? process.env.PROGRAM_ID,
  };
}

async function load(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source} returned HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(source, "utf8");
}

/** Re-run the match. Returns the standings the inputs produce. */
function replay(log: MatchLog): { standings: ReturnType<typeof standingsFrom>; hits: number } {
  const salt = fromHex(log.spreadSalt);
  if (!salt || salt.length !== 32) {
    throw new Error(`the log's spread salt is not 32 bytes of hex: ${log.spreadSalt}`);
  }
  const world = createWorld(log.roster.length, saltSeeds(salt));
  const hits: HitEvent[] = [];

  let expected = 0;
  for (const frame of log.ticks) {
    if (frame.tick !== expected) {
      throw new Error(`log jumps from tick ${expected} to ${frame.tick}`);
    }
    expected++;
    if (frame.inputs.length !== log.roster.length) {
      throw new Error(`tick ${frame.tick} has ${frame.inputs.length} inputs for ${log.roster.length} players`);
    }
    step(world, frame.inputs as (Input | null)[], hits);
  }

  return { standings: standingsFrom(world.players, log.roster), hits: hits.length };
}

function sameStandings(
  a: ReturnType<typeof standingsFrom>, b: readonly { slot: number; kills: number; deaths: number; place: number }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].slot !== b[i].slot || a[i].kills !== b[i].kills ||
      a[i].deaths !== b[i].deaths || a[i].place !== b[i].place) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const text = await load(opts.source);
  const hash = createHash("sha256").update(text).digest("hex");
  console.log(`log      ${opts.source}`);
  console.log(`bytes    ${text.length}`);
  console.log(`sha256   ${hash}`);

  const log = decanonicalise(text);
  if (!log) throw new Error("that file is not a canonical match log");

  // The file has to be the canonical form itself, or the hash on chain is the
  // hash of something else.
  if (canonicalise(log) !== text) {
    throw new Error("the file is not in canonical form: rehashing it would not match the chain");
  }

  console.log(`match    ${log.matchId}`);
  console.log(`map      ${log.map}`);
  console.log(`players  ${log.roster.length}`);
  console.log(`ticks    ${log.ticks.length}`);

  if (log.v !== LOG_VERSION) {
    throw new Error(
      `the log is version ${log.v}, this build replays version ${LOG_VERSION}. ` +
      "The rules changed between them; check out a commit from that version and run this again.",
    );
  }

  if (log.map !== MAP_ID) {
    throw new Error(
      `the log was played on map ${log.map}, this build has ${MAP_ID}. ` +
      "Check out the commit that built that map and run this again.",
    );
  }

  const started = Date.now();
  const result = replay(log);
  console.log(`replayed in ${Date.now() - started} ms, ${result.hits} hit events`);

  if (!sameStandings(result.standings, log.standings)) {
    console.error("STANDINGS DO NOT MATCH");
    console.error(`  replayed ${JSON.stringify(result.standings)}`);
    console.error(`  recorded ${JSON.stringify(log.standings)}`);
    throw new Error("the recorded result is not the result these inputs produce");
  }
  console.log("standings match the log");
  for (const row of log.standings) {
    console.log(`  ${row.place}. slot ${row.slot}  ${row.kills}k ${row.deaths}d  ${row.wallet}`);
  }

  if (!opts.rpcUrl || !opts.programId) {
    console.log("no --rpc and --program, so the on-chain hash was not checked");
    return;
  }

  // Loaded here, not at the top, so a replay of a free match needs no
  // @solana/web3.js at all.
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { matchPda } = await import("./chainrpc");
  const { decodeMatch } = await import("./chain");

  if (!/^(0|[1-9][0-9]{0,19})$/.test(log.matchId)) {
    console.log(`match id ${log.matchId} is not an on-chain id, so nothing to check against`);
    return;
  }
  const programId = new PublicKey(opts.programId);
  const connection = new Connection(opts.rpcUrl, "confirmed");
  const pda = matchPda(programId, BigInt(log.matchId));
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error(`no match account at ${pda.toBase58()}`);
  const account = decodeMatch(info.data);
  const onChain = Buffer.from(account.logHash).toString("hex");
  console.log(`account  ${pda.toBase58()}`);
  console.log(`state    ${account.state}`);
  console.log(`on chain ${onChain}`);

  if (account.state !== "Settled") {
    throw new Error(`match ${log.matchId} is ${account.state}, so no log hash has been committed`);
  }
  if (onChain !== hash) {
    throw new Error(
      `the chain was settled with ${onChain} but this log hashes to ${hash}: ` +
      "they are not the same match",
    );
  }
  console.log("the on-chain log hash matches this file");
}

main().then(
  () => { console.log("\nOK"); },
  (e: unknown) => {
    console.error(`\nFAILED: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
