// Token pots in the escrow program, in LiteSVM.
//
// Mints and token accounts are written straight into the SVM in the classic
// SPL layouts rather than created through instructions, which keeps every
// case to the one thing it tests (an amount, a freeze authority, a wrong
// owner) without a setup transaction in front of it. The program itself does
// its token work through the real SPL Token and Associated Token programs
// that LiteSVM ships.
//
// Build first, from the repo root, as for tests/arena.ts.

import { BN, Idl, Program, Provider, utils } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { decodeMatch, decodeTokenMatch, openTokenMatchFilters, parseMatchRef, rosterFromMatch } from "../packages/server/src/chain";
import { lockInstruction, settleInstruction, tokenMatchPda as serverTokenMatchPda, type ChainConfig } from "../packages/server/src/chainrpc";
import {
  ataOf as appAtaOf,
  claimTokenIx as appClaimTokenIx,
  createAtaIdempotentIx as appCreateAta,
  formatUnits,
  joinTokenIx as appJoinTokenIx,
  parseRef,
  planCreateToken,
} from "../apps/mobile/src/escrow";
import { parseRequest } from "../apps/mobile/src/bridge";
import {
  ataOf as scriptAtaOf,
  createAtaIdempotentIx as scriptCreateAta,
  initializeMint2Ix,
  loadKeypair,
  mintToIx,
  toRaw,
} from "../scripts/spl";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { Clock, FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";

const ROOT = path.join(__dirname, "..");
const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/arena.json"), "utf8")) as Idl;
const ELF = fs.readFileSync(path.join(ROOT, "target/deploy/arena.so"));
const PROGRAM_ID = new PublicKey(idl.address);

const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VJS2ZkE9UQ53q7Jy6R7SGd5dKu2e");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const [PROGRAM_DATA] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_V3);
const [CONFIG] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

const NO_PLACE = 255;
const SETTLE_WINDOW = 600;
const JOIN_WINDOW = 60;
const LOG_HASH = Array.from({ length: 32 }, (_, i) => i);
const SOL = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

const program = new Program(idl, { connection: new Connection("http://127.0.0.1:1") } as unknown as Provider);

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function tokenMatchPda(id: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("tmatch"), u64le(id)], PROGRAM_ID)[0];
}

function allowPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint"), mint.toBuffer()], PROGRAM_ID)[0];
}

function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
}

function anchorError(res: FailedTransactionMetadata): string | undefined {
  for (const line of res.meta().logs()) {
    const m = /Error Code: (\w+)\./.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** An SPL mint, 82 bytes. */
function mintData(decimals: number, authority: PublicKey, freeze: PublicKey | null): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(1, 0);
  authority.toBuffer().copy(b, 4);
  b.writeBigUInt64LE(0n, 36);
  b.writeUInt8(decimals, 44);
  b.writeUInt8(1, 45);
  if (freeze) {
    b.writeUInt32LE(1, 46);
    freeze.toBuffer().copy(b, 50);
  }
  return b;
}

/** An SPL token account, 165 bytes, initialized. */
function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b.writeUInt8(1, 108); // state: initialized
  return b;
}

class Harness {
  readonly svm = new LiteSVM();
  readonly payer = Keypair.generate();
  readonly admin = Keypair.generate();
  readonly resolver = Keypair.generate();
  readonly mintAuthority = Keypair.generate();
  private nextId = 1n;

  constructor() {
    const header = Buffer.alloc(45);
    header.writeUInt32LE(3, 0);
    header.writeUInt8(1, 12);
    this.admin.publicKey.toBuffer().copy(header, 13);
    const pd = Buffer.concat([header, ELF]);
    this.svm.setAccount(PROGRAM_DATA, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(BigInt(pd.length))), data: pd, owner: LOADER_V3, executable: false,
    });
    const pa = Buffer.alloc(36);
    pa.writeUInt32LE(2, 0);
    PROGRAM_DATA.toBuffer().copy(pa, 4);
    this.svm.setAccount(PROGRAM_ID, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(36n)), data: pa, owner: LOADER_V3, executable: true,
    });
    this.svm.airdrop(this.payer.publicKey, 1_000n * SOL);
    this.svm.airdrop(this.admin.publicKey, 10n * SOL);
  }

  send(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = this.payer.publicKey;
    tx.add(...ixs);
    tx.sign(this.payer, ...signers.filter((s) => !s.publicKey.equals(this.payer.publicKey)));
    const res = this.svm.sendTransaction(tx);
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
    expect(anchorError(res as FailedTransactionMetadata), (res as FailedTransactionMetadata).meta().logs().join("\n")).to.equal(code);
  }

  /** A failure with any error at all, for cases the runtime refuses before Anchor names it. */
  refused(ixs: TransactionInstruction[], signers: Keypair[]) {
    const res = this.send(ixs, signers);
    expect(res, "expected the transaction to fail").to.be.instanceOf(FailedTransactionMetadata);
  }

  warp(seconds: number) {
    const c = this.svm.getClock();
    this.svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)));
  }

  async initConfig() {
    const ix = await program.methods
      .initializeConfig(this.resolver.publicKey, new BN(1_000), new BN((1_000n * SOL).toString()), new BN(SETTLE_WINDOW))
      .accountsStrict({
        admin: this.admin.publicKey, config: CONFIG, program: PROGRAM_ID, programData: PROGRAM_DATA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    this.ok([ix], [this.admin]);
  }

  async setPaused(paused: boolean) {
    const ix = await program.methods
      .updateConfig(this.admin.publicKey, this.resolver.publicKey, new BN(1_000), new BN((1_000n * SOL).toString()), new BN(SETTLE_WINDOW), paused)
      .accountsStrict({ admin: this.admin.publicKey, config: CONFIG })
      .instruction();
    this.ok([ix], [this.admin]);
  }

  /** A mint written into the SVM. `owner` TOKEN_2022 makes a Token-2022 one. */
  mint(decimals: number, freeze: PublicKey | null = null, owner = TOKEN): PublicKey {
    const mint = Keypair.generate().publicKey;
    const data = mintData(decimals, this.mintAuthority.publicKey, freeze);
    this.svm.setAccount(mint, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(82n)), data, owner, executable: false,
    });
    return mint;
  }

  /** A token account holding `amount`, at a fresh address. */
  tokens(mint: PublicKey, owner: PublicKey, amount: bigint, at: PublicKey = Keypair.generate().publicKey): PublicKey {
    this.svm.setAccount(at, {
      lamports: Number(this.svm.minimumBalanceForRentExemption(165n)),
      data: tokenAccountData(mint, owner, amount), owner: TOKEN, executable: false,
    });
    return at;
  }

  amount(account: PublicKey): bigint {
    const a = this.svm.getAccount(account);
    if (!a) throw new Error("token account missing");
    return Buffer.from(a.data).readBigUInt64LE(64);
  }

  allowIx(mint: PublicKey, min: bigint, max: bigint, freeze: PublicKey | null = null, admin = this.admin.publicKey) {
    return program.methods
      .allowMint(new BN(min.toString()), new BN(max.toString()), freeze)
      .accountsStrict({ admin, config: CONFIG, mint, allow: allowPda(mint), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async allow(mint: PublicKey, min = 1n, max = U64_MAX, freeze: PublicKey | null = null) {
    this.ok([await this.allowIx(mint, min, max, freeze)], [this.admin]);
  }

  async updateMint(mint: PublicKey, min: bigint, max: bigint, enabled: boolean, freeze: PublicKey | null = null) {
    const ix = await program.methods
      .updateMint(new BN(min.toString()), new BN(max.toString()), freeze, enabled)
      .accountsStrict({ admin: this.admin.publicKey, config: CONFIG, mint, allow: allowPda(mint) })
      .instruction();
    this.ok([ix], [this.admin]);
  }

  async createIx(mint: PublicKey, stake: bigint, maxPlayers: number, id = this.nextId++) {
    const m = tokenMatchPda(id);
    const ix = await program.methods
      .createTokenMatch(new BN(id.toString()), new BN(stake.toString()), maxPlayers, new BN(JOIN_WINDOW))
      .accountsStrict({
        creator: this.payer.publicKey, config: CONFIG, mint, allow: allowPda(mint), tokenMatch: m,
        vault: ataOf(m, mint), tokenProgram: TOKEN, associatedTokenProgram: ATA, systemProgram: SystemProgram.programId,
      })
      .instruction();
    return { ix, m, vault: ataOf(m, mint), id };
  }

  async create(mint: PublicKey, stake: bigint, maxPlayers: number) {
    const c = await this.createIx(mint, stake, maxPlayers);
    this.ok([c.ix], []);
    return c;
  }

  joinIx(m: PublicKey, mint: PublicKey, player: PublicKey, from: PublicKey, vault = ataOf(m, mint)) {
    return program.methods.joinTokenMatch()
      .accountsStrict({ player, config: CONFIG, tokenMatch: m, mint, vault, playerTokens: from, tokenProgram: TOKEN })
      .instruction();
  }

  /** A new player with `amount` of the mint, joined. */
  async player(m: PublicKey, mint: PublicKey, amount: bigint) {
    const kp = Keypair.generate();
    const acc = this.tokens(mint, kp.publicKey, amount);
    this.ok([await this.joinIx(m, mint, kp.publicKey, acc)], [kp]);
    return { kp, acc };
  }

  settleIx(m: PublicKey, placements: number[], resolver = this.resolver.publicKey) {
    return program.methods.settleTokenMatch(placements, LOG_HASH)
      .accountsStrict({ resolver, config: CONFIG, tokenMatch: m })
      .instruction();
  }

  lockIx(m: PublicKey) {
    return program.methods.lockTokenMatch()
      .accountsStrict({ resolver: this.resolver.publicKey, config: CONFIG, tokenMatch: m })
      .instruction();
  }

  claimIx(m: PublicKey, mint: PublicKey, player: PublicKey, to: PublicKey, vault = ataOf(m, mint)) {
    return program.methods.claimToken()
      .accountsStrict({ player, tokenMatch: m, mint, vault, playerTokens: to, tokenProgram: TOKEN })
      .instruction();
  }

  /** Claims and returns exactly what arrived in the player's account. */
  async claim(m: PublicKey, mint: PublicKey, p: { kp: Keypair; acc: PublicKey }): Promise<bigint> {
    const before = this.amount(p.acc);
    this.ok([await this.claimIx(m, mint, p.kp.publicKey, p.acc)], [p.kp]);
    return this.amount(p.acc) - before;
  }

  state(m: PublicKey) {
    const acc = this.svm.getAccount(m);
    if (!acc) throw new Error("match missing");
    return program.coder.accounts.decode("tokenMatch", Buffer.from(acc.data));
  }
}

async function setup(): Promise<Harness> {
  const h = new Harness();
  await h.initConfig();
  return h;
}

describe("token pots: allowlist and mints", () => {
  it("creates a match only with an allowlisted mint", async () => {
    const h = await setup();
    const mint = h.mint(6);
    const c = await h.createIx(mint, 1_000_000n, 3);
    // No allowlist entry: the account the seeds point at does not exist.
    h.fails([c.ix], [], "AccountNotInitialized");
    await h.allow(mint, 1_000n, 10_000_000n);
    const c2 = await h.createIx(mint, 1_000_000n, 3);
    h.ok([c2.ix], []);
  });

  it("only the admin can allow a mint", async () => {
    const h = await setup();
    const mint = h.mint(6);
    const stranger = Keypair.generate();
    h.svm.airdrop(stranger.publicKey, SOL);
    h.fails([await h.allowIx(mint, 1n, 10n, null, stranger.publicKey)], [stranger], "Unauthorized");
  });

  it("refuses a Token-2022 mint", async () => {
    const h = await setup();
    const mint = h.mint(6, null, TOKEN_2022);
    h.fails([await h.allowIx(mint, 1n, 10n)], [h.admin], "AccountOwnedByWrongProgram");
  });

  it("refuses a mint with a freeze authority unless the allowlist names that exact authority", async () => {
    const h = await setup();
    const freezer = Keypair.generate().publicKey;
    const mint = h.mint(6, freezer);
    h.fails([await h.allowIx(mint, 1n, 10n, null)], [h.admin], "MintFreezeAuthority");
    h.fails([await h.allowIx(mint, 1n, 10n, Keypair.generate().publicKey)], [h.admin], "MintFreezeAuthority");
    h.ok([await h.allowIx(mint, 1n, 10n, freezer)], [h.admin]);
    // And the other way: naming an authority for a mint that has none.
    const plain = h.mint(6);
    h.fails([await h.allowIx(plain, 1n, 10n, freezer)], [h.admin], "MintFreezeAuthority");
  });

  it("holds every stake to the mint's own range, and a disabled mint takes no new matches", async () => {
    const h = await setup();
    const mint = h.mint(9);
    await h.allow(mint, 1_000n, 5_000n);
    h.fails([(await h.createIx(mint, 999n, 3)).ix], [], "StakeOutOfRange");
    h.fails([(await h.createIx(mint, 5_001n, 3)).ix], [], "StakeOutOfRange");
    h.ok([(await h.createIx(mint, 5_000n, 3)).ix], []);
    await h.updateMint(mint, 1_000n, 5_000n, false);
    h.fails([(await h.createIx(mint, 2_000n, 3)).ix], [], "MintNotAllowed");
  });

  it("makes the vault the match PDA's own associated token account", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m, vault } = await h.create(mint, 1_000n, 2);
    const acc = h.svm.getAccount(vault)!;
    expect(new PublicKey(acc.owner).equals(TOKEN)).to.equal(true);
    const data = Buffer.from(acc.data);
    expect(new PublicKey(data.subarray(0, 32)).equals(mint)).to.equal(true);
    expect(new PublicKey(data.subarray(32, 64)).equals(m), "vault authority is the match PDA").to.equal(true);
    expect(h.state(m).mint.equals(mint)).to.equal(true);
  });

  it("is not blocked by a stranger creating the vault account first", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const c = await h.createIx(mint, 1_000n, 2);
    // Anyone can make anyone's associated token account. Here a stranger
    // makes the match's vault before the match exists.
    h.tokens(mint, c.m, 0n, c.vault);
    h.ok([c.ix], []);
  });
});

describe("token pots: joining", () => {
  it("rejects a stake from a token account of another mint", async () => {
    const h = await setup();
    const mint = h.mint(6);
    const other = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 1_000n, 3);
    const p = Keypair.generate();
    const wrong = h.tokens(other, p.publicKey, 10_000n);
    h.fails([await h.joinIx(m, mint, p.publicKey, wrong)], [p], "ConstraintTokenMint");
  });

  it("rejects a stake from somebody else's token account", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 1_000n, 3);
    const victim = Keypair.generate();
    const theirs = h.tokens(mint, victim.publicKey, 10_000n);
    const thief = Keypair.generate();
    h.fails([await h.joinIx(m, mint, thief.publicKey, theirs)], [thief], "ConstraintTokenOwner");
    expect(h.amount(theirs)).to.equal(10_000n);
  });

  it("rejects any vault but the match's own", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 1_000n, 3);
    const p = Keypair.generate();
    const acc = h.tokens(mint, p.publicKey, 10_000n);
    const attackerVault = h.tokens(mint, Keypair.generate().publicKey, 0n);
    h.refused([await h.joinIx(m, mint, p.publicKey, acc, attackerVault)], [p]);
    expect(h.amount(acc)).to.equal(10_000n);
  });

  it("refuses the resolver as a player, and a join past the deadline", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 1_000n, 3);
    const acc = h.tokens(mint, h.resolver.publicKey, 10_000n);
    h.fails([await h.joinIx(m, mint, h.resolver.publicKey, acc)], [h.resolver], "ResolverCannotPlay");
    h.warp(JOIN_WINDOW + 1);
    const p = Keypair.generate();
    const pa = h.tokens(mint, p.publicKey, 10_000n);
    h.fails([await h.joinIx(m, mint, p.publicKey, pa)], [p], "DeadlinePassed");
  });

  it("moves exactly the stake into the vault", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m, vault } = await h.create(mint, 1_234n, 3);
    const p = await h.player(m, mint, 10_000n);
    expect(h.amount(p.acc)).to.equal(10_000n - 1_234n);
    expect(h.amount(vault)).to.equal(1_234n);
  });
});

describe("token pots: payouts, refunds and exits", () => {
  for (const n of [3, 4, 5, 6]) {
    it(`pays exactly the pot 50/30/20 with the dust to first, ${n} players`, async () => {
      const h = await setup();
      const mint = h.mint(6);
      await h.allow(mint);
      // An odd stake, so the split does not divide evenly.
      const stake = 1_000_003n;
      const { m, vault } = await h.create(mint, stake, n);
      const ps = [];
      for (let i = 0; i < n; i++) ps.push(await h.player(m, mint, stake));
      expect(h.state(m).state).to.have.property("locked");
      h.ok([await h.settleIx(m, [2, 0, 1])], [h.resolver]);
      const pot = stake * BigInt(n);
      const second = (pot * 3000n) / 10000n;
      const third = (pot * 2000n) / 10000n;
      const first = pot - second - third;
      expect(await h.claim(m, mint, ps[2])).to.equal(first);
      expect(await h.claim(m, mint, ps[0])).to.equal(second);
      expect(await h.claim(m, mint, ps[1])).to.equal(third);
      expect(first + second + third).to.equal(pot);
      expect(h.amount(vault)).to.equal(0n);
      for (const p of ps.slice(3)) h.fails([await h.claimIx(m, mint, p.kp.publicKey, p.acc)], [p.kp], "NothingToClaim");
    });
  }

  it("pays the whole pot to the winner of a two player match", async () => {
    const h = await setup();
    const mint = h.mint(9);
    await h.allow(mint);
    const { m } = await h.create(mint, 777n, 2);
    const a = await h.player(m, mint, 777n);
    const b = await h.player(m, mint, 777n);
    h.fails([await h.settleIx(m, [1, 0, NO_PLACE])], [h.resolver], "BadPlacement");
    h.ok([await h.settleIx(m, [1, NO_PLACE, NO_PLACE])], [h.resolver]);
    expect(await h.claim(m, mint, b)).to.equal(1_554n);
    h.fails([await h.claimIx(m, mint, a.kp.publicKey, a.acc)], [a.kp], "NothingToClaim");
  });

  it("refuses settlement from anyone but the resolver, a placement off the roster, and a second settle", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 100n, 3);
    for (let i = 0; i < 3; i++) await h.player(m, mint, 100n);
    const fake = Keypair.generate();
    h.fails([await h.settleIx(m, [0, 1, 2], fake.publicKey)], [fake], "Unauthorized");
    h.fails([await h.settleIx(m, [0, 1, 5])], [h.resolver], "BadPlacement");
    h.fails([await h.settleIx(m, [0, 0, 1])], [h.resolver], "BadPlacement");
    h.ok([await h.settleIx(m, [0, 1, 2])], [h.resolver]);
    h.fails([await h.settleIx(m, [0, 1, 2])], [h.resolver], "WrongState");
  });

  it("refunds every stake after the join deadline, once each", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m, vault } = await h.create(mint, 500n, 4);
    const a = await h.player(m, mint, 500n);
    const b = await h.player(m, mint, 500n);
    h.fails([await h.claimIx(m, mint, a.kp.publicKey, a.acc)], [a.kp], "NotClaimable");
    h.warp(JOIN_WINDOW + 1);
    expect(await h.claim(m, mint, a)).to.equal(500n);
    h.fails([await h.claimIx(m, mint, a.kp.publicKey, a.acc)], [a.kp], "AlreadyClaimed");
    expect(await h.claim(m, mint, b)).to.equal(500n);
    expect(h.amount(vault)).to.equal(0n);
  });

  it("refunds a locked match the resolver never settles, and settling after that fails", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 300n, 4);
    const a = await h.player(m, mint, 300n);
    await h.player(m, mint, 300n);
    h.ok([await h.lockIx(m)], [h.resolver]);
    h.warp(SETTLE_WINDOW + 1);
    expect(await h.claim(m, mint, a)).to.equal(300n);
    h.fails([await h.settleIx(m, [0, 1, NO_PLACE])], [h.resolver], "WrongState");
  });

  it("never pauses an exit, and pauses everything else", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 100n, 2);
    const a = await h.player(m, mint, 100n);
    const b = await h.player(m, mint, 100n);
    h.ok([await h.settleIx(m, [0, NO_PLACE, NO_PLACE])], [h.resolver]);
    await h.setPaused(true);
    h.fails([(await h.createIx(mint, 100n, 2)).ix], [], "Paused");
    expect(await h.claim(m, mint, a)).to.equal(200n);
    h.fails([await h.claimIx(m, mint, b.kp.publicKey, b.acc)], [b.kp], "NothingToClaim");
  });

  it("pays only to the claimer's own account of the right mint", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m } = await h.create(mint, 100n, 2);
    const a = await h.player(m, mint, 100n);
    await h.player(m, mint, 100n);
    h.ok([await h.settleIx(m, [0, NO_PLACE, NO_PLACE])], [h.resolver]);
    const thief = h.tokens(mint, Keypair.generate().publicKey, 0n);
    h.fails([await h.claimIx(m, mint, a.kp.publicKey, thief)], [a.kp], "ConstraintTokenOwner");
    const otherMint = h.tokens(h.mint(6), a.kp.publicKey, 0n);
    h.fails([await h.claimIx(m, mint, a.kp.publicKey, otherMint)], [a.kp], "ConstraintTokenMint");
    // A stranger cannot claim a winner's payout at all.
    const stranger = Keypair.generate();
    const sAcc = h.tokens(mint, stranger.publicKey, 0n);
    h.fails([await h.claimIx(m, mint, stranger.publicKey, sAcc)], [stranger], "NotAParticipant");
  });

  it("pays from the tracked pot: tokens sent to the vault cannot be claimed", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const { m, vault } = await h.create(mint, 1_000n, 2);
    const a = await h.player(m, mint, 1_000n);
    await h.player(m, mint, 1_000n);
    // Somebody tops the vault up by 5,000.
    h.tokens(mint, m, h.amount(vault) + 5_000n, vault);
    h.ok([await h.settleIx(m, [0, NO_PLACE, NO_PLACE])], [h.resolver]);
    expect(await h.claim(m, mint, a)).to.equal(2_000n);
    expect(h.amount(vault)).to.equal(5_000n);
  });

  /*
   * A token pot cannot overflow: every stake is in one mint, and a mint's
   * whole supply fits a u64 (mint_to refuses to go past it). So the test is
   * the largest pot that can exist, a supply of u64::MAX split between six,
   * settled with the u128 arithmetic in payouts_for and paid out to the last
   * unit. Balances here are written straight into the SVM and kept inside
   * that supply; past it the test would be describing a chain that cannot
   * exist.
   */
  it("settles the largest pot a mint can hold and pays out every unit of it", async () => {
    const h = await setup();
    const mint = h.mint(0);
    await h.allow(mint);
    const stake = U64_MAX / 6n;
    const { m, vault } = await h.create(mint, stake, 6);
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(await h.player(m, mint, stake));
    expect(h.amount(vault)).to.equal(stake * 6n);
    h.ok([await h.settleIx(m, [5, 0, 3])], [h.resolver]);
    const pot = stake * 6n;
    const second = (pot * 3000n) / 10000n;
    const third = (pot * 2000n) / 10000n;
    expect(await h.claim(m, mint, ps[5])).to.equal(pot - second - third);
    expect(await h.claim(m, mint, ps[0])).to.equal(second);
    expect(await h.claim(m, mint, ps[3])).to.equal(third);
    expect(h.amount(vault)).to.equal(0n);
  });
});

/*
 * The server's hand written token match layout and instructions, against the
 * real program, the same way tests/arena.ts holds the SOL ones to it. If the
 * TokenMatch layout or a discriminator moves, this fails here and not on the
 * droplet.
 */
describe("token pots: the server's lock and settle path", () => {
  function serverChain(h: Harness): ChainConfig {
    return {
      programId: PROGRAM_ID,
      resolver: h.resolver,
      potMint: null,
      rpcUrl: "",
      connection: null as unknown as Connection,
    };
  }

  it("decodes, locks and settles a token match with the server's own code", async () => {
    const h = await setup();
    const mint = h.mint(6);
    await h.allow(mint);
    const stake = 7_000_001n;
    const { m, id } = await h.create(mint, stake, 4);
    expect(serverTokenMatchPda(PROGRAM_ID, id).equals(m)).to.equal(true);
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(await h.player(m, mint, stake));

    // Open, listed by the server's filters: every memcmp matches the real bytes.
    const raw = Buffer.from(h.svm.getAccount(m)!.data);
    const f = openTokenMatchFilters(mint.toBase58(), stake);
    expect(raw.length).to.equal(f.dataSize);
    for (const c of f.memcmp) {
      const want = Buffer.from(utils.bytes.bs58.decode(c.bytes));
      expect(raw.subarray(c.offset, c.offset + want.length).equals(want), `memcmp at ${c.offset}`).to.equal(true);
    }

    const open = decodeTokenMatch(raw);
    expect(open.currency).to.equal("skr");
    expect(open.mint).to.equal(mint.toBase58());
    expect(open.matchId).to.equal(id);
    expect(open.stake).to.equal(stake);
    expect(open.count).to.equal(3);
    expect(open.maxPlayers).to.equal(4);
    expect(open.state).to.equal("Open");
    expect(rosterFromMatch(open).map((r) => r.wallet)).to.deep.equal(ps.map((p) => p.kp.publicKey.toBase58()));
    // A token match is not a SOL match, whatever its bytes look like.
    expect(() => decodeMatch(raw)).to.throw();

    const chain = serverChain(h);
    const ref = parseMatchRef(`skr-${id}`)!;
    h.ok([lockInstruction(chain, ref)], [h.resolver]);
    expect(decodeTokenMatch(Buffer.from(h.svm.getAccount(m)!.data)).state).to.equal("Locked");

    const hash = Buffer.alloc(32, 7);
    h.ok([settleInstruction(chain, ref, [2, 0, 1], hash)], [h.resolver]);
    const settled = decodeTokenMatch(Buffer.from(h.svm.getAccount(m)!.data));
    expect(settled.state).to.equal("Settled");
    expect(settled.placements).to.deep.equal([2, 0, 1]);
    expect(Buffer.from(settled.logHash).equals(hash)).to.equal(true);
    const pot = stake * 3n;
    expect(settled.payouts.reduce((a, b) => a + b, 0n)).to.equal(pot);
    expect(await h.claim(m, mint, ps[2])).to.equal(settled.payouts[0]);
  });

  it("a SOL ref with the same number does not touch the token match", async () => {
    const h = await setup();
    const mint = h.mint(0);
    await h.allow(mint);
    const { m, id } = await h.create(mint, 5n, 2);
    await h.player(m, mint, 5n);
    await h.player(m, mint, 5n);
    const chain = serverChain(h);
    // Locked by joining in full; a settle aimed at the SOL escrow's id space
    // names an account that does not exist and fails, and the token match
    // is untouched.
    h.refused([settleInstruction(chain, { currency: "sol", id }, [0, 255, 255], Buffer.alloc(32))], [h.resolver]);
    expect(decodeTokenMatch(Buffer.from(h.svm.getAccount(m)!.data)).state).to.equal("Locked");
  });
});

/*
 * The app's own token pot transactions, against the real program: what the
 * phone would send for a create, a join and a claim, built by
 * apps/mobile/src/escrow.ts from nothing but a tier index and a currency name.
 */
describe("token pots: the app's create, join and claim", () => {
  it("creates and stakes from a tier and a currency, with decimals from the mint", async () => {
    const h = await setup();
    const decimals = 6;
    const mint = h.mint(decimals);
    await h.allow(mint, 1n, U64_MAX);

    // What the page may send: a tier and a currency name. Nothing else parses.
    const req = parseRequest(JSON.stringify({ id: "a", t: "escrow", action: "create", tier: 1, currency: "skr" }));
    if (req.t !== "escrow" || req.action !== "create") throw new Error("not a create");
    const planned = await planCreateToken(req.tier, 4242n, { mint, decimals, minStake: 1n, maxStake: U64_MAX });
    expect(planned.amount).to.equal(50n * 10n ** BigInt(decimals));
    expect(planned.unit).to.equal("Test SKR (devnet)");
    expect(planned.key).to.equal("skr-4242");
    expect(formatUnits(planned.amount, planned.decimals)).to.equal("50");

    const creator = Keypair.generate();
    h.svm.airdrop(creator.publicKey, 10n * SOL);
    const creatorAta = h.tokens(mint, creator.publicKey, planned.amount, appAtaOf(creator.publicKey, mint));
    h.ok(planned.build(creator.publicKey), [creator]);
    const m = tokenMatchPda(4242n);
    expect(h.amount(ataOf(m, mint))).to.equal(planned.amount);
    expect(h.amount(creatorAta)).to.equal(0n);

    // A second player joins with the app's join instruction, from their own ATA.
    const b = Keypair.generate();
    const bAta = h.tokens(mint, b.publicKey, planned.amount, appAtaOf(b.publicKey, mint));
    h.ok([appJoinTokenIx(b.publicKey, mint, parseRef("skr-4242").id)], [b]);

    // Locked by the resolver, settled with b first, then b claims with the
    // app's claim, which creates the ATA first if it is missing and is a
    // no-op when it is there.
    h.ok([await h.lockIx(m)], [h.resolver]);
    h.ok([await h.settleIx(m, [1, NO_PLACE, NO_PLACE])], [h.resolver]);
    h.svm.airdrop(b.publicKey, SOL);
    h.ok([appCreateAta(b.publicKey, b.publicKey, mint), appClaimTokenIx(b.publicKey, mint, 4242n)], [b]);
    expect(h.amount(bAta)).to.equal(planned.amount * 2n);
  });

  it("a claim creates the winner's token account when they no longer have one", async () => {
    const h = await setup();
    const mint = h.mint(0);
    await h.allow(mint);
    const { m } = await h.create(mint, 9n, 2);
    const a = await h.player(m, mint, 9n);
    await h.player(m, mint, 9n);
    h.ok([await h.settleIx(m, [0, NO_PLACE, NO_PLACE])], [h.resolver]);
    const ata = appAtaOf(a.kp.publicKey, mint);
    expect(h.svm.getAccount(ata)).to.equal(null);
    h.svm.airdrop(a.kp.publicKey, SOL);
    const id = BigInt(h.state(m).matchId.toString());
    h.ok([appCreateAta(a.kp.publicKey, a.kp.publicKey, mint), appClaimTokenIx(a.kp.publicKey, mint, id)], [a.kp]);
    expect(h.amount(ata)).to.equal(18n);
  });

  it("refuses a create the allowlist range would refuse, before the wallet opens", async () => {
    let refused = "";
    try {
      await planCreateToken(0, 1n, { mint: Keypair.generate().publicKey, decimals: 6, minStake: 1n, maxStake: 9_999_999n });
    } catch (e) {
      refused = (e as Error).message;
    }
    expect(refused).to.match(/outside what the allowlist accepts/);
    let noTier = "";
    try {
      await planCreateToken(3, 1n, { mint: Keypair.generate().publicKey, decimals: 6, minStake: 1n, maxStake: U64_MAX });
    } catch (e) {
      noTier = (e as Error).message;
    }
    expect(noTier).to.match(/no Test SKR \(devnet\) tier/);
  });
});

/*
 * The devnet scripts' own SPL instructions (scripts/spl.ts), run against the
 * SVM's real token and associated token programs: a mint made the way
 * create-test-skr makes it, tokens minted the way airdrop-test-skr does, and
 * a match staked from the account that produced.
 */
describe("token pots: the devnet scripts' instructions", () => {
  it("make a mint, an account and a balance the escrow accepts", async () => {
    const h = await setup();
    const authority = Keypair.generate();
    h.svm.airdrop(authority.publicKey, 10n * SOL);
    const mintKp = Keypair.generate();
    h.ok([
      SystemProgram.createAccount({
        fromPubkey: h.payer.publicKey, newAccountPubkey: mintKp.publicKey,
        lamports: Number(h.svm.minimumBalanceForRentExemption(82n)), space: 82, programId: TOKEN,
      }),
      initializeMint2Ix(mintKp.publicKey, 6, authority.publicKey, null),
    ], [mintKp]);
    const mint = mintKp.publicKey;
    const raw = Buffer.from(h.svm.getAccount(mint)!.data);
    expect(raw[44]).to.equal(6);
    expect(raw.readUInt32LE(46)).to.equal(0, "no freeze authority");

    const player = Keypair.generate();
    const ata = scriptAtaOf(player.publicKey, mint);
    expect(ata.equals(ataOf(player.publicKey, mint))).to.equal(true);
    const amount = toRaw("12.5", 6);
    expect(amount).to.equal(12_500_000n);
    // Twice: the second create is the idempotent no-op the script relies on.
    h.ok([scriptCreateAta(h.payer.publicKey, player.publicKey, mint), mintToIx(mint, ata, authority.publicKey, amount)], [authority]);
    h.ok([scriptCreateAta(h.payer.publicKey, player.publicKey, mint)], []);
    expect(h.amount(ata)).to.equal(amount);

    await h.allow(mint, toRaw("1", 6), toRaw("100", 6));
    const { m, vault } = await h.create(mint, toRaw("10", 6), 2);
    h.ok([await h.joinIx(m, mint, player.publicKey, ata)], [player]);
    expect(h.amount(vault)).to.equal(10_000_000n);
    expect(h.amount(ata)).to.equal(2_500_000n);
  });

  it("convert amounts exactly and refuse what does not fit the mint", () => {
    expect(toRaw("0", 9)).to.equal(0n);
    expect(toRaw("1.000000001", 9)).to.equal(1_000_000_001n);
    expect(toRaw("7", 0)).to.equal(7n);
    expect(() => toRaw("1.5", 0)).to.throw(/decimal places/);
    expect(() => toRaw("-1", 6)).to.throw();
    expect(() => toRaw("1e3", 6)).to.throw();
    expect(() => toRaw("18446744073709551616", 0)).to.throw(/u64/);
  });

  it("refuse a key file inside the repository", () => {
    const kp = Keypair.generate();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "ff-key-")), "k.json");
    writeFileSync(outside, JSON.stringify(Array.from(kp.secretKey)));
    expect(loadKeypair(outside, ROOT).publicKey.equals(kp.publicKey)).to.equal(true);
    expect(() => loadKeypair(path.join(ROOT, "deployer.json"), ROOT)).to.throw(/inside the repository/);
    expect(() => loadKeypair(path.join(ROOT, "scripts", "..", "k.json"), ROOT)).to.throw(/inside the repository/);
  });
});
