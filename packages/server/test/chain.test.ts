// Configuration, log files and settlement, without a chain.
//
// Nothing here touches devnet. The parts that need a real program are tested
// against LiteSVM in tests/arena.ts; these are the parts that decide whether
// the server will start at all, and what it writes down when a round ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAP_ID,
  TICK_HZ,
  createWorld,
  step,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { FREE_SALT_BYTES, saltSeeds } from "../../shared/weapons";
import { toHex } from "../../shared/sha256";
import {
  canonicalise,
  decanonicalise,
  standingsFrom,
  type MatchLog,
  type RosterEntry,
} from "../../shared/protocol";
import { hasChainEnv, placementsFrom, settleData } from "../src/chain";
import { assertKeyFilePrivate, chainFromEnv, loadResolver } from "../src/chainrpc";
import { finishMatch, writeMatchLog } from "../src/settlement";

const PROGRAM = "HoktNWjdhuts9nzV76UyqUn6FCqJ57LwAizFYbjD4TCe";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ff-test-"));
}

/**
 * A keypair file in the Solana CLI format, at the given mode.
 *
 * A real ed25519 keypair, not 64 random bytes: web3.js checks that the public
 * half matches the seed, which is worth knowing because it means a corrupted
 * key file is caught at startup rather than at the first signature.
 */
let keySeq = 0;
function keyFile(dir: string, mode: number): string {
  // A fresh name each time: one of the modes under test is read only, and
  // rewriting that file would fail for a reason that has nothing to do with
  // what is being tested.
  const path = join(dir, `resolver-${keySeq++}.json`);
  const kp = nacl.sign.keyPair();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  chmodSync(path, mode);
  return path;
}

function roster(n: number): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ slot: i, wallet: `w${i}`, collection: null, mint: null });
  }
  return out;
}

/* --------------------------------------------------- the key on disk --- */

test("a resolver key readable by group or others is refused", () => {
  const dir = tmp();
  for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777, 0o660]) {
    const path = keyFile(dir, mode);
    assert.throws(
      () => assertKeyFilePrivate(path),
      /readable by group or others/,
      `mode ${mode.toString(8)} should have been refused`,
    );
  }
});

test("a resolver key only the owner can read is accepted", () => {
  const dir = tmp();
  for (const mode of [0o600, 0o400, 0o700]) {
    const path = keyFile(dir, mode);
    assertKeyFilePrivate(path);
    const kp = loadResolver(path);
    assert.equal(kp.publicKey.toBase58().length > 30, true);
  }
});

test("a key file that is not a keypair is refused", () => {
  const dir = tmp();
  const path = join(dir, "resolver.json");
  for (const content of ["[]", "{}", "null", "[1,2,3]", "not json"]) {
    writeFileSync(path, content);
    chmodSync(path, 0o600);
    assert.throws(() => loadResolver(path));
  }
});

/* ------------------------------------------------------ configuration --- */

test("no chain configuration means free rooms only", () => {
  assert.equal(hasChainEnv({}), false);
  assert.equal(chainFromEnv({}, false), null);
});

test("a half configured chain refuses to start", () => {
  const dir = tmp();
  const path = keyFile(dir, 0o600);
  const full = {
    RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: PROGRAM,
    RESOLVER_KEYPAIR_PATH: path,
  };
  for (const missing of ["RPC_URL", "PROGRAM_ID", "RESOLVER_KEYPAIR_PATH"] as const) {
    const env = { ...full };
    delete env[missing];
    assert.equal(hasChainEnv(env), true, `${missing} missing is still chain config`);
    assert.throws(() => chainFromEnv(env, false), /have to be set together/);
  }
  // All three, and it comes up.
  const chain = chainFromEnv(full, false);
  assert.ok(chain);
  assert.equal(chain!.programId.toBase58(), PROGRAM);
  assert.equal(chain!.rpcUrl, full.RPC_URL);
});

test("dev mode and a resolver key on one machine refuses to start", () => {
  // The rule in CLAUDE.md: the dev roster keys are public, so a box with both
  // is a box where anyone can join a room on the machine that signs payouts.
  const dir = tmp();
  const env = {
    RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: PROGRAM,
    RESOLVER_KEYPAIR_PATH: keyFile(dir, 0o600),
  };
  assert.throws(() => chainFromEnv(env, true), /ARENA_DEV is set and a resolver key/);
  assert.ok(chainFromEnv(env, false));
});

test("a program id that is not the one the IDL was built for refuses to start", () => {
  const dir = tmp();
  assert.throws(() => chainFromEnv({
    RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: "11111111111111111111111111111111",
    RESOLVER_KEYPAIR_PATH: keyFile(dir, 0o600),
  }, false), /idl\/arena\.json is for/);
});

/* ------------------------------------------------------------- the log --- */

/** A short real match, so the log under test is one the sim produced. */
function playedLog(matchId: string, slots = 3): { log: MatchLog; hash: string } {
  const r = roster(slots);
  const world = createWorld(slots, saltSeeds(FREE_SALT_BYTES));
  const log: MatchLog = {
    v: 4,
    matchId,
    map: MAP_ID,
    spreadSalt: toHex(FREE_SALT_BYTES),
    roster: r,
    startedAt: 1730000000000,
    ticks: [],
    standings: [],
  };
  const hits: HitEvent[] = [];
  for (let t = 0; t < 2 * TICK_HZ; t++) {
    const inputs: (Input | null)[] = r.map((_, slot) => (
      slot === 1 && t % 3 === 0 ? null : {
        tick: t, view: t, moveX: slot * 20, moveY: 100, yaw: t * 7 + slot * 400,
        pitch: 0, fire: t % 9 === 0 ? 1 : 0, jump: 0, reload: 0, weapon: 0,
      }
    ));
    step(world, inputs, hits);
    log.ticks.push({ tick: t, inputs });
  }
  log.standings = standingsFrom(world.players, r);
  return { log, hash: createHash("sha256").update(canonicalise(log)).digest("hex") };
}

test("the canonical form round trips exactly", () => {
  const { log } = playedLog("round-trip", 4);
  const text = canonicalise(log);
  const back = decanonicalise(text);
  assert.ok(back, "a canonical log should parse");
  // Byte for byte, or a verifier would rehash to something else and conclude
  // the server lied.
  assert.equal(canonicalise(back!), text);
  assert.deepEqual(back!.standings, log.standings);
  assert.deepEqual(back!.roster, log.roster);
  assert.equal(back!.spreadSalt, log.spreadSalt);
  assert.equal(back!.ticks.length, log.ticks.length);
  assert.deepEqual(back!.ticks[3].inputs, log.ticks[3].inputs);
});

test("decanonicalise refuses anything that is not a canonical log", () => {
  for (const bad of ["", "{}", "[]", "null", "not json", '[1,2,3]', '["a","b","c","d","e","f","g","h"]']) {
    assert.equal(decanonicalise(bad), null, `should refuse ${bad}`);
  }
});

test("the log written to disk is exactly the bytes that were hashed", () => {
  const dir = tmp();
  const { log, hash } = playedLog("12345");
  const path = writeMatchLog(dir, log);
  assert.equal(path, join(dir, "12345.json"));

  const onDisk = readFileSync(path, "utf8");
  assert.equal(createHash("sha256").update(onDisk).digest("hex"), hash);
  assert.equal(onDisk, canonicalise(log));
  // And it is readable back into a log, which is what the replay does.
  assert.ok(decanonicalise(onDisk));
});

test("a match id that could escape the log directory is refused", () => {
  const dir = tmp();
  for (const matchId of ["../escape", "a/b", "..", ".", "with space", "semi;colon", ""]) {
    const { log } = playedLog("ok");
    log.matchId = matchId;
    assert.throws(() => writeMatchLog(dir, log), /not safe as a file name/);
  }
});

/* -------------------------------------------------------- finishing --- */

test("finishing a free match writes the log and settles nothing", async () => {
  const dir = tmp();
  const { log, hash } = playedLog("free-1");
  let settled = 0;
  await finishMatch(log, hash, {
    logDir: dir,
    staked: null,
    settle: async () => { settled++; },
  });
  assert.equal(settled, 0, "a free match has nothing to settle");
  assert.equal(readFileSync(join(dir, "free-1.json"), "utf8"), canonicalise(log));
});

test("finishing a staked match settles the placements and that log hash", async () => {
  const dir = tmp();
  const { log, hash } = playedLog("77", 6);
  const calls: { matchId: bigint; placements: number[]; hash: string }[] = [];
  await finishMatch(log, hash, {
    logDir: dir,
    staked: { matchId: 77n, count: 6 },
    settle: async (matchId, placements, logHash) => {
      calls.push({ matchId, placements, hash: logHash.toString("hex") });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].matchId, 77n);
  assert.equal(calls[0].hash, hash, "the hash settled must be the hash of the log on disk");
  assert.deepEqual(
    calls[0].placements,
    placementsFrom(log.standings, 6),
    "placements must be the finishing order",
  );
  // The file is there to back up what was settled.
  assert.equal(
    createHash("sha256").update(readFileSync(join(dir, "77.json"), "utf8")).digest("hex"),
    hash,
  );
});

test("a staked match on a server with no resolver is left to refund", async () => {
  const dir = tmp();
  const { log, hash } = playedLog("78", 3);
  await assert.rejects(
    () => finishMatch(log, hash, { logDir: dir, staked: { matchId: 78n, count: 3 } }),
    /no chain configuration/,
  );
  // The log is still written: it is the thing anyone checking the refund
  // would want, and writing it first is why.
  assert.ok(readFileSync(join(dir, "78.json"), "utf8").length > 0);
});

test("settle data is the discriminator and the two fixed arguments", () => {
  const hash = randomBytes(32);
  const data = settleData([2, 0, 1], hash);
  assert.equal(data.length, 8 + 3 + 32);
  assert.deepEqual(Array.from(data.subarray(8, 11)), [2, 0, 1]);
  assert.equal(data.subarray(11).toString("hex"), hash.toString("hex"));
  assert.throws(() => settleData([0, 1], hash), /three entries/);
  assert.throws(() => settleData([0, 1, 2], randomBytes(31)), /32 bytes/);
  assert.throws(() => settleData([0, 1, 300], hash), /not a byte/);
});
