// Escrow program tests.
//
// These run the compiled program in LiteSVM rather than against a validator,
// because half of what matters here is time (join and settle deadlines) and
// the upgrade authority check, and LiteSVM lets a test set the clock and write
// the program data account directly.
//
// Build first, from the repo root:
//   cd programs/arena && cargo build-sbf --tools-version v1.57 && cd ../..
//   anchor idl build -p arena -o target/idl/arena.json
//   npm test

import { BN, Idl, Program, Provider } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { Clock, FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import {
  decodeMatch,
  placementsFrom,
  rosterFromMatch,
  settleData,
  NO_PLACE as SERVER_NO_PLACE,
} from "../packages/server/src/chain";
import { canonicalise, standingsFrom, type MatchLog } from "../packages/shared/protocol";
import { MAP_ID } from "../packages/shared/map";
import { FREE_SALT_BYTES } from "../packages/shared/weapons";
import { LOCK_BEFORE_DEADLINE, STAKE_TIERS } from "../packages/shared/tiers";
import { lockDecision } from "../packages/server/src/lobby";
import { lockInstruction, type ChainConfig } from "../packages/server/src/chainrpc";
import {
  claimIx as appClaimIx,
  joinIx as appJoinIx,
  planCreate,
} from "../apps/mobile/src/escrow";
import { toHex } from "../packages/shared/sha256";

const ROOT = path.join(__dirname, "..");
const IDL_PATH = path.join(ROOT, "target/idl/arena.json");
const SO_PATH = path.join(ROOT, "target/deploy/arena.so");

const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
const PROGRAM_ID = new PublicKey(idl.address);
const ELF = fs.readFileSync(SO_PATH);

const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [PROGRAM_DATA] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_V3);
const [CONFIG] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

const NO_PLACE = 255;
const SETTLE_WINDOW = 600;
const JOIN_WINDOW = 60;
const LOG_HASH = Array.from({ length: 32 }, (_, i) => i);
const SOL = 1_000_000_000n;

// Instructions are only built here, never sent through the connection, so the
// provider never talks to an RPC.
const program = new Program(idl, {
  connection: new Connection("http://127.0.0.1:1"),
} as unknown as Provider);

function matchPda(id: number | bigint): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([Buffer.from("match"), le], PROGRAM_ID)[0];
}

/** Pulls the Anchor error name out of the program logs. */
function anchorError(res: FailedTransactionMetadata): string | undefined {
  for (const line of res.meta().logs()) {
    const m = /Error Code: (\w+)\./.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

class Harness {
  readonly svm = new LiteSVM();
  /** Pays every fee, so balance deltas on players are exactly the transfers. */
  readonly payer = Keypair.generate();
  readonly admin = Keypair.generate();
  readonly resolver = Keypair.generate();
  private nextMatchId = 1n;

  constructor() {
    this.deployUpgradeable(this.admin.publicKey);
    this.svm.airdrop(this.payer.publicKey, 1_000n * SOL);
    this.svm.airdrop(this.admin.publicKey, 10n * SOL);
  }

  /**
   * Writes the program and program data accounts by hand, the way the
   * upgradeable loader lays them out, so initialize_config sees a real upgrade
   * authority. Program data goes first because loading the program account
   * reads the ELF out of it.
   */
  private deployUpgradeable(authority: PublicKey) {
    const header = Buffer.alloc(45);
    header.writeUInt32LE(3, 0); // ProgramData
    header.writeBigUInt64LE(0n, 4); // slot
    header.writeUInt8(1, 12); // Some(authority)
    authority.toBuffer().copy(header, 13);
    const pdData = Buffer.concat([header, ELF]);
    this.svm.setAccount(PROGRAM_DATA, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(BigInt(pdData.length))),
      data: pdData,
      owner: LOADER_V3,
      executable: false,
    });

    const progData = Buffer.alloc(36);
    progData.writeUInt32LE(2, 0); // Program
    PROGRAM_DATA.toBuffer().copy(progData, 4);
    this.svm.setAccount(PROGRAM_ID, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(36n)),
      data: progData,
      owner: LOADER_V3,
      executable: true,
    });
  }

  send(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = this.payer.publicKey;
    tx.add(...ixs);
    tx.sign(this.payer, ...signers.filter((s) => !s.publicKey.equals(this.payer.publicKey)));
    const res = this.svm.sendTransaction(tx);
    // A fresh blockhash per transaction, so repeating an identical call is a
    // new transaction and not rejected as a duplicate signature.
    this.svm.expireBlockhash();
    return res;
  }

  ok(ixs: TransactionInstruction[], signers: Keypair[]): TransactionMetadata {
    const res = this.send(ixs, signers);
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(`transaction failed: ${res.toString()}\n${res.meta().logs().join("\n")}`);
    }
    return res;
  }

  fails(ixs: TransactionInstruction[], signers: Keypair[], code: string) {
    const res = this.send(ixs, signers);
    expect(res, `expected ${code}, transaction succeeded`).to.be.instanceOf(FailedTransactionMetadata);
    expect(anchorError(res as FailedTransactionMetadata)).to.equal(code);
  }

  warp(seconds: number) {
    const c = this.svm.getClock();
    this.svm.setClock(
      new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)),
    );
  }

  balance(key: PublicKey): bigint {
    return this.svm.getBalance(key) ?? 0n;
  }

  funded(): Keypair {
    const kp = Keypair.generate();
    this.svm.airdrop(kp.publicKey, 100n * SOL);
    return kp;
  }

  initConfigIx(admin: PublicKey) {
    return program.methods
      .initializeConfig(this.resolver.publicKey, new BN(1_000), new BN((1_000n * SOL).toString()), new BN(SETTLE_WINDOW))
      .accountsStrict({
        admin,
        config: CONFIG,
        program: PROGRAM_ID,
        programData: PROGRAM_DATA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async initConfig() {
    this.ok([await this.initConfigIx(this.admin.publicKey)], [this.admin]);
  }

  async setPaused(paused: boolean) {
    const ix = await program.methods
      .updateConfig(
        this.admin.publicKey,
        this.resolver.publicKey,
        new BN(1_000),
        new BN((1_000n * SOL).toString()),
        new BN(SETTLE_WINDOW),
        paused,
      )
      .accountsStrict({ admin: this.admin.publicKey, config: CONFIG })
      .instruction();
    this.ok([ix], [this.admin]);
  }

  async createMatch(stake: bigint, maxPlayers: number): Promise<PublicKey> {
    const id = this.nextMatchId++;
    const m = matchPda(id);
    const ix = await program.methods
      .createMatch(new BN(id.toString()), new BN(stake.toString()), maxPlayers, new BN(JOIN_WINDOW))
      .accountsStrict({
        creator: this.payer.publicKey,
        config: CONFIG,
        matchAccount: m,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    this.ok([ix], []);
    return m;
  }

  joinIx(m: PublicKey, player: PublicKey) {
    return program.methods
      .joinMatch()
      .accountsStrict({ player, config: CONFIG, matchAccount: m, systemProgram: SystemProgram.programId })
      .instruction();
  }

  async join(m: PublicKey, player: Keypair) {
    this.ok([await this.joinIx(m, player.publicKey)], [player]);
  }

  settleIx(m: PublicKey, placements: number[], resolver = this.resolver.publicKey) {
    return program.methods
      .settle(placements, LOG_HASH)
      .accountsStrict({ resolver, config: CONFIG, matchAccount: m })
      .instruction();
  }

  async settle(m: PublicKey, placements: number[]) {
    this.ok([await this.settleIx(m, placements)], [this.resolver]);
  }

  claimIx(m: PublicKey, player: PublicKey) {
    return program.methods.claim().accountsStrict({ player, matchAccount: m }).instruction();
  }

  /** Claims and returns the exact lamports the player received. */
  async claim(m: PublicKey, player: Keypair): Promise<bigint> {
    const before = this.balance(player.publicKey);
    this.ok([await this.claimIx(m, player.publicKey)], [player]);
    return this.balance(player.publicKey) - before;
  }

  /** A full match, locked automatically by the last join. */
  async lockedMatch(n: number, stake = SOL): Promise<{ m: PublicKey; players: Keypair[] }> {
    const m = await this.createMatch(stake, n);
    const players: Keypair[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.funded();
      await this.join(m, p);
      players.push(p);
    }
    expect(this.matchState(m).state).to.have.property("locked");
    return { m, players };
  }

  matchState(m: PublicKey) {
    const acc = this.svm.getAccount(m);
    if (!acc) throw new Error("match account missing");
    return program.coder.accounts.decode("match", Buffer.from(acc.data));
  }
}

async function setup(): Promise<Harness> {
  const h = new Harness();
  await h.initConfig();
  return h;
}

describe("arena escrow: attacks", () => {
  it("rejects initialize_config from anyone but the upgrade authority", async () => {
    const h = new Harness();
    const attacker = h.funded();
    h.fails([await h.initConfigIx(attacker.publicKey)], [attacker], "Unauthorized");
    // The real authority can still initialise afterwards.
    await h.initConfig();
  });

  it("rejects settle from a non-resolver", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    const attacker = h.funded();
    h.fails([await h.settleIx(m, [0, 1, 2], attacker.publicKey)], [attacker], "Unauthorized");
  });

  it("rejects a placement naming a slot at or above count", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    h.fails([await h.settleIx(m, [0, 1, 3])], [h.resolver], "BadPlacement");
    h.fails([await h.settleIx(m, [5, 0, 1])], [h.resolver], "BadPlacement");
  });

  it("rejects the same slot listed twice", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    h.fails([await h.settleIx(m, [0, 1, 0])], [h.resolver], "BadPlacement");
    h.fails([await h.settleIx(m, [2, 2, 1])], [h.resolver], "BadPlacement");
  });

  it("rejects a second settle", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    await h.settle(m, [0, 1, 2]);
    h.fails([await h.settleIx(m, [2, 1, 0])], [h.resolver], "WrongState");
  });

  it("rejects settle after the deadline", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    h.warp(SETTLE_WINDOW + 1);
    h.fails([await h.settleIx(m, [0, 1, 2])], [h.resolver], "DeadlinePassed");
  });

  it("rejects a second claim by the same player", async () => {
    const h = await setup();
    const { m, players } = await h.lockedMatch(3);
    await h.settle(m, [0, 1, 2]);
    await h.claim(m, players[0]);
    h.fails([await h.claimIx(m, players[0].publicKey)], [players[0]], "AlreadyClaimed");
  });

  it("rejects a claim from a non-participant", async () => {
    const h = await setup();
    const { m } = await h.lockedMatch(3);
    await h.settle(m, [0, 1, 2]);
    const outsider = h.funded();
    h.fails([await h.claimIx(m, outsider.publicKey)], [outsider], "NotAParticipant");
  });

  it("rejects the resolver joining a match", async () => {
    const h = await setup();
    h.svm.airdrop(h.resolver.publicKey, 10n * SOL);
    const m = await h.createMatch(SOL, 3);
    h.fails([await h.joinIx(m, h.resolver.publicKey)], [h.resolver], "ResolverCannotPlay");
  });
});

describe("arena escrow: paths that must work", () => {
  it("pays exactly the stake total when lamports are donated to the match", async () => {
    const h = await setup();
    const stake = SOL;
    const { m, players } = await h.lockedMatch(4, stake);

    const donor = h.funded();
    const donation = 7n * SOL + 123n;
    h.ok(
      [SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: m, lamports: donation })],
      [donor],
    );

    await h.settle(m, [2, 0, 3]);
    const before = h.balance(m);
    let paid = 0n;
    for (const i of [2, 0, 3]) paid += await h.claim(m, players[i]);

    const pot = stake * 4n;
    expect(paid).to.equal(pot);
    // The donation is stranded in the account, not paid to anyone.
    expect(before - h.balance(m)).to.equal(pot);
    expect(h.balance(m) >= donation).to.equal(true);
  });

  it("lets players claim while the program is paused", async () => {
    const h = await setup();
    const stake = SOL;
    const { m, players } = await h.lockedMatch(3, stake);
    await h.settle(m, [1, 2, 0]);
    await h.setPaused(true);

    // Pause does block new entry, which is what it is for.
    h.fails([await h.settleIx(m, [0, 1, 2])], [h.resolver], "Paused");

    const pot = stake * 3n;
    expect(await h.claim(m, players[1])).to.equal((pot * 5_000n) / 10_000n);
    expect(await h.claim(m, players[2])).to.equal((pot * 3_000n) / 10_000n);
    expect(await h.claim(m, players[0])).to.equal((pot * 2_000n) / 10_000n);
  });

  it("refunds every stake once the settle deadline passes", async () => {
    const h = await setup();
    const stake = 250_000_000n;
    const { m, players } = await h.lockedMatch(5, stake);
    h.warp(SETTLE_WINDOW + 1);

    for (const p of players) expect(await h.claim(m, p)).to.equal(stake);
    expect(h.matchState(m).state).to.have.property("refunding");
    // Refunding is terminal: a late settle cannot also pay out.
    h.fails([await h.settleIx(m, [0, 1, 2])], [h.resolver], "WrongState");
  });

  for (let n = 2; n <= 6; n++) {
    it(`pays out exactly the pot with ${n} players`, async () => {
      const h = await setup();
      // An odd stake so the basis point split has rounding dust to lose.
      const stake = 1_000_000_007n;
      const { m, players } = await h.lockedMatch(n, stake);

      // Last joiner wins, to avoid only ever testing slot 0.
      const placements = n >= 3 ? [n - 1, 0, 1] : [n - 1, NO_PLACE, NO_PLACE];
      await h.settle(m, placements);

      const state = h.matchState(m);
      const recorded = state.payouts.reduce((a: bigint, b: BN) => a + BigInt(b.toString()), 0n);
      const pot = stake * BigInt(n);
      expect(recorded).to.equal(pot);

      let paid = 0n;
      for (const slot of placements) {
        if (slot === NO_PLACE) continue;
        paid += await h.claim(m, players[slot]);
      }
      expect(paid).to.equal(pot);

      // Everyone else has nothing to claim.
      for (let slot = 0; slot < n; slot++) {
        if (placements.includes(slot)) continue;
        h.fails([await h.claimIx(m, players[slot].publicKey)], [players[slot]], "NothingToClaim");
      }
    });
  }
});

/*
 * The server's own encoder and decoder, against the real program.
 *
 * packages/server/src/chain.ts writes the settle instruction and reads the
 * match account by hand rather than through @coral-xyz/anchor, because the
 * droplet has 512 MB and anchor is a large thing to load on it. These are the
 * tests that make that safe: if the program's layout or discriminator ever
 * moves, the hand written version stops matching here rather than in
 * production. Run against LiteSVM, never devnet.
 */
describe("the server's settlement path", () => {
  /** A real log hash, so the value on chain is one a replay could produce. */
  function logHashFor(matchId: string, roster: { slot: number; wallet: string }[]): {
    log: MatchLog;
    hash: Buffer;
  } {
    const log: MatchLog = {
      v: 4,
      matchId,
      map: MAP_ID,
      spreadSalt: toHex(FREE_SALT_BYTES),
      roster: roster.map((r) => ({ ...r, collection: null, mint: null })),
      startedAt: 0,
      ticks: [],
      standings: [],
    };
    log.standings = standingsFrom(
      roster.map((_, i) => ({ kills: roster.length - i, deaths: i })),
      log.roster,
    );
    return { log, hash: createHash("sha256").update(canonicalise(log)).digest() };
  }

  it("decodes a locked match account the way the program wrote it", async () => {
    const h = await setup();
    const { m, players } = await h.lockedMatch(4, 2n * SOL);

    const acc = h.svm.getAccount(m);
    if (!acc) throw new Error("match account missing");
    const decoded = decodeMatch(Buffer.from(acc.data));

    expect(decoded.state).to.equal("Locked");
    expect(decoded.count).to.equal(4);
    expect(decoded.maxPlayers).to.equal(4);
    expect(decoded.stake.toString()).to.equal((2n * SOL).toString());
    expect(decoded.settleDeadline).to.be.greaterThan(0);
    expect(Buffer.from(decoded.logHash).every((b) => b === 0)).to.equal(true);

    // Slot is the index in the account's players array, which is join order.
    // The roster has to preserve it: the placements the resolver submits are
    // indices into this, so a reordering here would pay the wrong people.
    const roster = rosterFromMatch(decoded);
    expect(roster.map((r) => r.slot)).to.deep.equal([0, 1, 2, 3]);
    expect(roster.map((r) => r.wallet)).to.deep.equal(
      players.map((p) => p.publicKey.toBase58()),
    );
  });

  it("decoding refuses anything that is not a match account", async () => {
    const h = await setup();
    const config = h.svm.getAccount(CONFIG);
    if (!config) throw new Error("config account missing");
    // The config account is a different size, so it fails on length.
    expect(() => decodeMatch(Buffer.from(config.data))).to.throw(/expected/);
    expect(() => decodeMatch(Buffer.alloc(16))).to.throw(/expected/);

    // Right size, wrong discriminator: a match sized account belonging to
    // some other program would otherwise decode into plausible nonsense.
    const { m } = await h.lockedMatch(3);
    const real = Buffer.from(h.svm.getAccount(m)!.data);
    const forged = Buffer.from(real);
    forged[0] ^= 0xff;
    expect(() => decodeMatch(forged)).to.throw(/not a Match/);
    // Untouched, it still decodes, so the test above detected the edit.
    expect(decodeMatch(real).count).to.equal(3);
  });

  it("settles with instruction data the server built by hand", async () => {
    const h = await setup();
    const { m, players } = await h.lockedMatch(5);
    const decoded = decodeMatch(Buffer.from(h.svm.getAccount(m)!.data));
    const roster = rosterFromMatch(decoded);
    const { log, hash } = logHashFor("1", roster);

    const placements = placementsFrom(log.standings, decoded.count);
    expect(placements).to.deep.equal([0, 1, 2]);

    // The same instruction the server sends, built the same way: the
    // discriminator out of the IDL and the two fixed size arguments after it.
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: h.resolver.publicKey, isSigner: true, isWritable: false },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: m, isSigner: false, isWritable: true },
      ],
      data: settleData(placements, hash),
    });
    h.ok([ix], [h.resolver]);

    const after = h.matchState(m);
    expect(after.state).to.have.property("settled");
    expect(Array.from(after.placements as number[])).to.deep.equal(placements);
    expect(Buffer.from(after.logHash as number[]).toString("hex"))
      .to.equal(hash.toString("hex"));

    // And the winner can take the money, which is the only proof that the
    // placements meant what the program thought they meant.
    const first = players[placements[0]];
    const paid = await h.claim(m, first);
    expect(paid > 0n).to.equal(true);
  });

  it("pays everything to first in a two player match, as the server builds it", async () => {
    const h = await setup();
    const { m, players } = await h.lockedMatch(2);
    const decoded = decodeMatch(Buffer.from(h.svm.getAccount(m)!.data));
    const roster = rosterFromMatch(decoded);
    const { log, hash } = logHashFor("2", roster);

    // Two players: the program pays one place and wants the rest unused.
    const placements = placementsFrom(log.standings, 2);
    expect(placements).to.deep.equal([0, SERVER_NO_PLACE, SERVER_NO_PLACE]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: h.resolver.publicKey, isSigner: true, isWritable: false },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: m, isSigner: false, isWritable: true },
      ],
      data: settleData(placements, hash),
    });
    h.ok([ix], [h.resolver]);

    const pot = 2n * SOL;
    const paid = await h.claim(m, players[0]);
    expect(paid).to.equal(pot);
  });

  it("refuses to build placements the program would reject", () => {
    const roster = [0, 1, 2].map((slot) => ({
      slot, wallet: `w${slot}`, collection: null, mint: null,
    }));
    const standings = standingsFrom(
      [{ kills: 3, deaths: 0 }, { kills: 2, deaths: 1 }, { kills: 1, deaths: 2 }],
      roster,
    );
    // A slot the match does not have.
    expect(() => placementsFrom(
      [{ slot: 9, wallet: "x", kills: 1, deaths: 0, place: 1 }, ...standings.slice(1)],
      3,
    )).to.throw(/not in a 3 player match/);
    // The same slot twice.
    expect(() => placementsFrom(
      [standings[0], standings[0], standings[2]], 3,
    )).to.throw(/placed twice/);
    // Not enough places to fill.
    expect(() => placementsFrom(standings.slice(0, 2), 3)).to.throw(/no place 3/);
    // And the data builder refuses a hash of the wrong size.
    expect(() => settleData([0, 1, 2], new Uint8Array(31))).to.throw(/32 bytes/);
  });
});

describe("holders matches: app, lobby and resolver together", () => {
  /**
   * The server's lock instruction needs a ChainConfig. Only the program id and
   * the resolver key are read to build it; the connection is never used.
   */
  function chainFor(h: Harness): ChainConfig {
    return {
      connection: new Connection("http://127.0.0.1:1"),
      programId: PROGRAM_ID,
      resolver: h.resolver,
      rpcUrl: "http://127.0.0.1:1",
    };
  }

  /** The app's own create transaction: create_match and join_match, one signature. */
  function appCreate(h: Harness, creator: Keypair, tier: number, id: bigint) {
    const planned = planCreate(tier, id);
    h.ok(planned.build(creator.publicKey), [creator]);
    return matchPda(id);
  }

  function decoded(h: Harness, m: PublicKey) {
    return decodeMatch(Buffer.from(h.svm.getAccount(m)!.data));
  }

  function now(h: Harness): number {
    return Number(h.svm.getClock().unixTimestamp);
  }

  it("the lobby's lock rule agrees with the program, on presence and on the deadline", async () => {
    const h = await setup();
    const a = h.funded();
    const b = h.funded();
    const m = appCreate(h, a, 0, 9001n);
    let acc = decoded(h, m);
    expect(acc.count).to.equal(1, "create also took the creator's seat");
    expect(acc.stake.toString()).to.equal(STAKE_TIERS[0].lamports);

    // One player: the rule waits, and the program agrees it cannot lock.
    expect(lockDecision(acc, new Set([a.publicKey.toBase58()]), now(h))).to.equal("wait");
    h.fails([lockInstruction(chainFor(h), 9001n)], [h.resolver], "BadPlayerCount");

    h.ok([appJoinIx(b.publicKey, 9001n)], [b]);
    acc = decoded(h, m);
    // Two joined, one in the lobby, ten minutes left: wait.
    expect(lockDecision(acc, new Set([a.publicKey.toBase58()]), now(h))).to.equal("wait");
    // Inside the last minute: lock, present or not, and the program takes it.
    h.warp(acc.joinDeadline - now(h) - LOCK_BEFORE_DEADLINE);
    expect(lockDecision(acc, new Set([a.publicKey.toBase58()]), now(h))).to.equal("lock");
    h.ok([lockInstruction(chainFor(h), 9001n)], [h.resolver]);
    acc = decoded(h, m);
    expect(acc.state).to.equal("Locked");
    expect(lockDecision(acc, new Set(), now(h))).to.equal("open-room");
  });

  it("an expired lobby is one the program also refuses to lock", async () => {
    const h = await setup();
    const a = h.funded();
    const b = h.funded();
    const m = appCreate(h, a, 1, 9002n);
    h.ok([appJoinIx(b.publicKey, 9002n)], [b]);
    const acc = decoded(h, m);
    h.warp(acc.joinDeadline - now(h) + 1);
    expect(lockDecision(acc, new Set([a.publicKey.toBase58(), b.publicKey.toBase58()]), now(h)))
      .to.equal("expired");
    h.fails([lockInstruction(chainFor(h), 9002n)], [h.resolver], "DeadlinePassed");
    // And both get their stake back through the app's claim instruction.
    const before = h.balance(a.publicKey);
    h.ok([appClaimIx(a.publicKey, 9002n)], [a]);
    expect((h.balance(a.publicKey) - before).toString()).to.equal(STAKE_TIERS[1].lamports);
  });

  it("create, join, lock, settle and claim, end to end, as each part builds it", async () => {
    const h = await setup();
    const a = h.funded();
    const b = h.funded();
    const c = h.funded();
    const stake = BigInt(STAKE_TIERS[2].lamports);

    // The app creates and takes seat 0; two more join through the app.
    const aBefore = h.balance(a.publicKey);
    const m = appCreate(h, a, 2, 9003n);
    h.ok([appJoinIx(b.publicKey, 9003n)], [b]);
    h.ok([appJoinIx(c.publicKey, 9003n)], [c]);
    let acc = decoded(h, m);
    expect(acc.count).to.equal(3);

    // Everyone is in the lobby: the server's rule says lock, and its
    // instruction locks it.
    const everyone = new Set([a, b, c].map((k) => k.publicKey.toBase58()));
    expect(lockDecision(acc, everyone, now(h))).to.equal("lock");
    h.ok([lockInstruction(chainFor(h), 9003n)], [h.resolver]);
    acc = decoded(h, m);
    expect(acc.state).to.equal("Locked");

    // The room's roster is the account's, in slot order.
    const roster = rosterFromMatch(acc);
    expect(roster.map((r) => r.wallet)).to.deep.equal([a, b, c].map((k) => k.publicKey.toBase58()));

    // The round ends with c first, a second, b third. The server settles.
    const log: MatchLog = {
      v: 5, matchId: "9003", map: MAP_ID, spreadSalt: toHex(FREE_SALT_BYTES),
      roster, startedAt: 0, ticks: [], standings: [],
    };
    log.standings = standingsFrom(
      [{ kills: 2, deaths: 1 }, { kills: 0, deaths: 3 }, { kills: 5, deaths: 0 }],
      log.roster,
    );
    const hash = createHash("sha256").update(canonicalise(log)).digest();
    const placements = placementsFrom(log.standings, acc.count);
    expect(placements).to.deep.equal([2, 0, 1]);
    h.ok([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: h.resolver.publicKey, isSigner: true, isWritable: false },
        { pubkey: CONFIG, isSigner: false, isWritable: false },
        { pubkey: m, isSigner: false, isWritable: true },
      ],
      data: settleData(placements, hash),
    })], [h.resolver]);

    // Each claims through the app's instruction and gets exactly 50/30/20.
    const pot = stake * 3n;
    const paid = (k: Keypair) => {
      const before = h.balance(k.publicKey);
      h.ok([appClaimIx(k.publicKey, 9003n)], [k]);
      return h.balance(k.publicKey) - before;
    };
    expect(paid(c).toString()).to.equal((pot - (pot * 3000n) / 10000n - (pot * 2000n) / 10000n).toString());
    expect(paid(a).toString()).to.equal(((pot * 3000n) / 10000n).toString());
    expect(paid(b).toString()).to.equal(((pot * 2000n) / 10000n).toString());
    // A second claim is refused.
    h.fails([appClaimIx(a.publicKey, 9003n)], [a], "AlreadyClaimed");

    // a staked, paid rent for the match account (fees are on the harness
    // payer), and got second place back. The rent stays in the account,
    // which the program keeps open as the on-chain half of the audit.
    const rent = h.balance(m);
    expect((h.balance(a.publicKey) - aBefore + stake + rent).toString())
      .to.equal(((pot * 3000n) / 10000n).toString());
  });
});
