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
