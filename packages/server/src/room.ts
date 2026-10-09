import { createHash, randomBytes } from "node:crypto";
import {
  MAP_ID,
  ROUND_TICKS,
  SNAPSHOT_EVERY,
  TICK_HZ,
  TICK_MS,
  createWorld,
  step,
  type HitEvent,
  type Input,
  type WorldState,
} from "../../shared/sim";
import {
  canonicalise,
  quantPitch,
  standingsFrom,
  type MatchLog,
  type RosterEntry,
  LOG_VERSION,
  type SnapshotPlayer,
  type Standing,
} from "../../shared/protocol";
import { PITCH_LIMIT } from "../../shared/sim";
import { FREE_SALT_BYTES, saltSeeds } from "../../shared/weapons";
import { sha256Hex, toHex } from "../../shared/sha256";
import { Bot } from "./bot";

/**
 * Free or staked.
 *
 * The distinction exists so that one rule can be enforced in one place: a
 * staked room never gets a bot. Everything else about the two is identical,
 * including the trust boundary, because a free room is where the trust
 * boundary gets exercised before there is money on it.
 */
export type RoomKind = "free" | "staked";

/** How far ahead of the server a client may buffer before we drain faster. */
const BUFFER_TARGET = 2;
const BUFFER_MAX = 8;

/**
 * Ticks the queue must stay above BUFFER_TARGET before we drain two. Draining
 * two applies only the later input, so the earlier one's movement is lost and
 * the client's prediction snaps back. A burst from ordinary timer jitter clears
 * on its own within a few ticks, so only a sustained backlog, a client clock
 * genuinely running fast, is worth that cost. Half a second.
 */
const OVER_TARGET_TICKS = 30;

/** Ticks of silence before a seat is considered gone. Ten seconds. */
const TIMEOUT_TICKS = 600;

/** How often each seat is pinged, for the debug overlay's ping readout. */
const PING_EVERY = 60;

/**
 * Roster wallet for a free seat nobody has claimed yet, and for one a bot
 * took. Neither is a base58 public key, so neither can be signed for: a guest
 * claims a slot by producing a signature, and "open" cannot produce one.
 *
 * A bot's slot is relabelled when the bot is seated, which means the match
 * log says which slots were bots rather than leaving it to be guessed at.
 */
export const FREE_SEAT_OPEN = "open";
export const FREE_SEAT_BOT = "bot";

/** Seconds of round left below which matchmaking stops offering a room. */
export const MIN_JOINABLE_SECONDS = 30;

export interface Seat {
  slot: number;
  wallet: string;
  queue: Input[];
  ack: number;
  lastSeenTick: number;
  send: (msg: unknown) => void;
  close: (reason: string) => void;
  /** Set on a bot's seat. Everything below the queue ignores it. */
  bot?: true;
  /**
   * Inputs at or below this tick were dropped from a full queue, so a resend
   * of one is stale rather than new. Optional: a fresh seat has none.
   */
  floor?: number;
  /** Outstanding ping id, when it was sent, and the last measured round trip. */
  pingId: number;
  pingSentAt: number;
  rtt: number;
}

export class Room {
  readonly matchId: string;
  readonly kind: RoomKind;
  readonly roster: RosterEntry[];
  readonly world: WorldState;

  /**
   * Pellet spread salt, and the commitment to it.
   *
   * A staked room draws 32 random bytes at creation, before anybody has
   * joined and so before anybody could have asked for a particular pattern.
   * `spreadCommit` goes out in every accepted message; the bytes themselves
   * stay here until the match ends, then go into the `over` message and the
   * match log. A free room uses the fixed public salt, because there is
   * nothing to win and nobody to convince.
   */
  readonly spreadSalt: Uint8Array;
  readonly spreadCommit: string;

  private seats: (Seat | null)[];
  private bots: (Bot | null)[];
  /**
   * Free rooms: which slots a guest has claimed.
   *
   * Tracked separately rather than read back off the roster wallet. The
   * roster is also where a bot's slot gets labelled, and a guest's wallet is
   * base58, which can begin with any letters at all including the ones a bot
   * label uses. Deciding who may take a seat from a string comparison would
   * mean a guest whose key happened to start the right way could be turned
   * out of their own slot.
   */
  private claimedSeat: boolean[];
  /** Consecutive ticks each slot's queue has been above BUFFER_TARGET. */
  private overTarget: number[];
  /** Slots that have had a person seated in them at least once. */
  private claimedOnce: boolean[];
  /**
   * Per slot counters for the end of match log line, next to the sim's own
   * (world.stats): applied inputs with the trigger down, and inputs that
   * never reached the sim, by reason.
   */
  readonly counters = {
    fireTicks: [] as number[],
    stale: [] as number[],
    overflow: [] as number[],
    malformed: [] as number[],
    reconnects: [] as number[],
  };
  private log: MatchLog;
  private timer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private lastSnapTick = 0;
  private startedAt = 0;
  private started = false;
  private finished = false;
  private onFinish: (log: MatchLog, hash: string) => void;
  private startWhenSeated: number;
  private fillWithBots: boolean;
  private fillTimer: NodeJS.Timeout | null = null;
  private fillAfterMs: number;

  /**
   * `startWhenSeated` of 0 means the caller starts the clock. Anything higher
   * starts it automatically once that many seats are connected, so a dev round
   * does not burn its 90 seconds before the second tab has joined.
   *
   * `fillWithBots` seats a bot in every empty slot at the moment the round
   * starts. Free rooms only.
   *
   * `fillAfterMs` is the short wait a free room gives real players before it
   * fills what is left with bots and starts. It begins when the first player
   * sits down, so an empty room costs nothing and a room with somebody in it
   * always becomes a game.
   */
  constructor(
    matchId: string,
    roster: RosterEntry[],
    onFinish: (log: MatchLog, hash: string) => void,
    startWhenSeated = 0,
    kind: RoomKind = "staked",
    fillWithBots = false,
    fillAfterMs = 0,
  ) {
    this.matchId = matchId;
    this.kind = kind;
    this.roster = roster;
    // Every seat carries an SKR tier in the log, 0 until a join sets one, so
    // the roster written to disk reads back exactly as it was.
    for (const r of roster) r.skr ??= 0;
    this.spreadSalt = kind === "staked"
      ? new Uint8Array(randomBytes(32))
      : FREE_SALT_BYTES;
    this.spreadCommit = sha256Hex(this.spreadSalt);
    this.world = createWorld(roster.length, saltSeeds(this.spreadSalt));
    this.seats = new Array(roster.length).fill(null);
    this.bots = new Array(roster.length).fill(null);
    this.claimedSeat = new Array(roster.length).fill(false);
    this.overTarget = new Array(roster.length).fill(0);
    this.claimedOnce = new Array(roster.length).fill(false);
    for (const k of Object.keys(this.counters) as (keyof typeof this.counters)[]) {
      this.counters[k] = new Array(roster.length).fill(0);
    }
    this.onFinish = onFinish;
    this.startWhenSeated = startWhenSeated;
    this.fillWithBots = fillWithBots && kind === "free";
    this.fillAfterMs = kind === "free" ? fillAfterMs : 0;
    this.log = {
      v: LOG_VERSION,
      matchId,
      map: MAP_ID,
      // Filled in at finish: the salt is a secret until the round is over.
      spreadSalt: "",
      roster,
      startedAt: 0,
      ticks: [],
      standings: [],
    };
  }

  /* ------------------------------------------------------------ seats --- */

  /**
   * Slot comes from roster order, which is fixed on chain before anyone
   * connects. Deriving it from connection order would make the match log
   * depend on who dialled in first, and replays would not reproduce.
   */
  seat(seat: Seat): void {
    // A human takes the slot off whatever bot was holding it.
    this.bots[seat.slot] = null;

    const existing = this.seats[seat.slot];
    if (this.started && this.claimedOnce[seat.slot]) this.counters.reconnects[seat.slot]++;
    this.claimedOnce[seat.slot] = true;
    if (existing && !existing.bot) {
      // A second socket for the same wallet. Keep the new one and drop the old,
      // so a player whose phone dropped can rejoin, but never run two at once.
      existing.close("replaced by a newer connection");
    }
    this.seats[seat.slot] = seat;
    this.overTarget[seat.slot] = 0;
    seat.lastSeenTick = this.world.tick;

    if (!this.started && this.startWhenSeated > 0 && this.seatedCount() >= this.startWhenSeated) {
      this.start();
      return;
    }

    if (this.started || this.fillAfterMs <= 0) return;

    // A full house starts at once. Anything less waits a little for company,
    // then takes bots.
    if (this.seatedCount() >= this.roster.length) {
      this.start();
      return;
    }
    if (!this.fillTimer) {
      this.fillTimer = setTimeout(() => {
        this.fillTimer = null;
        if (!this.started) this.start();
      }, this.fillAfterMs);
    }
  }

  /**
   * Only clears the slot if it still holds this seat. A replaced connection
   * closes after its successor has been seated, and without this check its
   * close handler would evict the player who just reconnected.
   */
  unseat(slot: number, seat: Seat): void {
    if (this.seats[slot] === seat) this.seats[slot] = null;
  }

  /** Connected players, not counting bots. */
  seatedCount(): number {
    let n = 0;
    for (const s of this.seats) if (s && !s.bot) n++;
    return n;
  }

  botCount(): number {
    let n = 0;
    for (const b of this.bots) if (b) n++;
    return n;
  }

  /**
   * Seat a bot in one slot.
   *
   * Refused outright in a staked room. The people in that room put SOL in the
   * escrow to play each other, and a server controlled player in it would be
   * the house taking a share of their pot. Throwing rather than returning
   * false is deliberate: there is no sensible way for a caller to carry on
   * after asking for this.
   */
  addBot(slot: number): void {
    if (this.kind !== "free") {
      throw new Error(`refusing to add a bot to staked match ${this.matchId}`);
    }
    if (slot < 0 || slot >= this.roster.length) {
      throw new Error(`no slot ${slot} in match ${this.matchId}`);
    }
    if (this.seats[slot] && !this.seats[slot]!.bot) return;
    this.bots[slot] = new Bot(slot, slot + 1);
    // Say so on the roster, so the match log records which slots were bots.
    // Not over a guest's wallet: a slot somebody claimed and then dropped out
    // of stays theirs to come back to, and the log should say who it was.
    if (!this.claimedSeat[slot] && this.roster[slot].wallet === FREE_SEAT_OPEN) {
      this.roster[slot].wallet = `${FREE_SEAT_BOT}-${slot}`;
    }
    // A bot gets a seat like anyone else. Its inputs then travel the queue,
    // the backlog drain and the match log by exactly the same route a phone's
    // do, which is the only way to be sure a bot cannot do something a player
    // cannot.
    this.seats[slot] = {
      slot,
      wallet: this.roster[slot].wallet,
      queue: [],
      ack: -1,
      lastSeenTick: this.world.tick,
      send: () => { /* nobody is listening */ },
      close: () => { /* nothing to close */ },
      bot: true,
      pingId: 0,
      pingSentAt: 0,
      rtt: 0,
    };
  }

  /** Fill every empty slot with a bot. Free rooms only, same refusal. */
  fillBots(): void {
    for (let slot = 0; slot < this.roster.length; slot++) {
      if (!this.seats[slot]) this.addBot(slot);
    }
  }

  /* ------------------------------------------------------- free seats --- */

  /**
   * Take a seat in a free room for `wallet`.
   *
   * Returns the slot, or null if there is nowhere to sit. A wallet already on
   * the roster gets its own slot back, which is what makes a reconnect work:
   * the guest key lives for the page's session, so a dropped socket can come
   * back to the same player rather than to a new one.
   *
   * A bot holding a slot does not count as occupied. Displacing one is the
   * point: it means somebody arriving late gets a game immediately instead of
   * an empty room, and seat() drops the bot when the human sits down.
   */
  claimFreeSeat(wallet: string): number | null {
    if (this.kind !== "free") return null;
    for (let slot = 0; slot < this.roster.length; slot++) {
      if (this.claimedSeat[slot] && this.roster[slot].wallet === wallet) return slot;
    }
    for (let slot = 0; slot < this.roster.length; slot++) {
      if (this.claimedSeat[slot]) continue;
      const live = this.seats[slot];
      if (live && !live.bot) continue;
      this.claimedSeat[slot] = true;
      this.roster[slot].wallet = wallet;
      return slot;
    }
    return null;
  }

  /** Slots a guest could take: empty, or held by a bot. */
  freeSeats(): number {
    if (this.kind !== "free") return 0;
    let n = 0;
    for (let slot = 0; slot < this.roster.length; slot++) {
      const live = this.seats[slot];
      if (!live || live.bot) n++;
    }
    return n;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Seconds of round left, or the whole round if it has not started. */
  secondsLeft(): number {
    if (!this.started) return ROUND_TICKS / TICK_HZ;
    return Math.max(0, (ROUND_TICKS - this.world.tick) / TICK_HZ);
  }

  /**
   * Is this room worth sending a new player to?
   *
   * Not finished, somewhere to sit, and enough round left to be worth
   * joining. Walking into the last ten seconds of a match is worse than
   * waiting a moment for a fresh one.
   */
  joinable(): boolean {
    return !this.finished && this.freeSeats() > 0 &&
      (!this.started || this.secondsLeft() >= MIN_JOINABLE_SECONDS);
  }

  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Accept a batch of inputs. Nothing here trusts the contents beyond shape:
   * the queue is bounded, inputs for ticks already consumed are dropped, and
   * duplicates for the same tick keep the first arrival so a late resend
   * cannot rewrite a decision the server already made.
   */
  acceptInputs(slot: number, batch: Input[]): void {
    const seat = this.seats[slot];
    if (!seat || this.finished) return;
    seat.lastSeenTick = this.world.tick;

    const floor = Math.max(seat.ack, seat.floor ?? -1);
    for (const inp of batch) {
      // Resends of what has already been applied are normal: every batch
      // repeats the last few ticks. Only count them when they are not.
      if (inp.tick <= floor) continue;
      if (seat.queue.some((q) => q.tick === inp.tick)) continue;
      seat.queue.push(inp);
    }
    seat.queue.sort((a, b) => a.tick - b.tick);
    // After a stall on mobile data a second of inputs can land at once. Keep
    // the newest: they are what the player is doing now, and playing out a
    // second of old movement would leave them that far behind themselves.
    while (seat.queue.length > BUFFER_MAX) {
      seat.floor = seat.queue.shift()!.tick;
      this.counters.overflow[slot]++;
    }
  }

  /** A batch the socket layer refused as malformed, for the counters. */
  rejectBatch(slot: number, size: number): void {
    if (slot >= 0 && slot < this.roster.length) this.counters.malformed[slot] += size;
  }

  /** The end of match counters, one entry per slot. */
  report(): Record<string, unknown>[] {
    const st = this.world.stats;
    return this.roster.map((r, slot) => ({
      slot,
      who: this.bots[slot] || r.wallet === FREE_SEAT_BOT ? "bot" : "player",
      shotsRequested: this.counters.fireTicks[slot],
      shotsAccepted: st.shots[slot],
      hits: st.hits[slot],
      rewindClamped: st.rewindClamped[slot],
      coverRefused: st.coverRefused[slot],
      rejectedInputs: this.counters.overflow[slot] + this.counters.malformed[slot],
      overflow: this.counters.overflow[slot],
      malformed: this.counters.malformed[slot],
      reconnects: this.counters.reconnects[slot],
    }));
  }

  /**
   * Answer to a ping. Nothing depends on it but the number on the sender's
   * own debug overlay, so an unanswered or dishonest pong costs its own
   * client an accurate readout and nobody else anything.
   */
  pong(slot: number, id: number): void {
    const seat = this.seats[slot];
    if (!seat || seat.pingId === 0 || id !== seat.pingId) return;
    seat.rtt = Date.now() - seat.pingSentAt;
    seat.pingId = 0;
  }

  /* ------------------------------------------------------------- loop --- */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.log.startedAt = this.startedAt;
    this.nextTickAt = this.startedAt;
    if (this.fillWithBots) this.fillBots();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.fillTimer) clearTimeout(this.fillTimer);
    this.fillTimer = null;
  }

  private schedule(): void {
    // setInterval drifts and silently coalesces under load. Recompute the
    // deadline from a fixed origin every tick instead, so the simulation clock
    // stays tied to wall time.
    const delay = Math.max(0, this.nextTickAt - Date.now());
    this.timer = setTimeout(() => this.pump(), delay);
  }

  private pump(): void {
    if (this.finished) return;

    // Catch up if we fell behind, but never more than a few ticks at once. An
    // unbounded catch-up loop on a 512 MB box turns one slow GC into a spiral.
    let budget = 5;
    while (Date.now() >= this.nextTickAt && budget-- > 0 && !this.finished) {
      this.tick();
      this.nextTickAt += TICK_MS;
    }

    // Still behind after the budget means we cannot keep real time. Skip
    // forward rather than accumulating debt forever.
    if (Date.now() - this.nextTickAt > 250) {
      this.nextTickAt = Date.now();
    }
    if (!this.finished) this.schedule();
  }

  private tick(): void {
    const tick = this.world.tick;
    const inputs: (Input | null)[] = new Array(this.seats.length).fill(null);

    // Bots go through acceptInputs, the queue and the drain below, exactly as
    // a connected phone does. Nothing downstream of here can tell the
    // difference, and their inputs land in the match log with everyone
    // else's, so a round with bots in it still replays.
    for (let slot = 0; slot < this.bots.length; slot++) {
      const bot = this.bots[slot];
      if (!bot) continue;
      this.acceptInputs(slot, [bot.think(this.world)]);
    }

    for (let slot = 0; slot < this.seats.length; slot++) {
      const seat = this.seats[slot];
      if (!seat) continue;

      if (!seat.bot && tick - seat.lastSeenTick > TIMEOUT_TICKS) {
        console.warn(`[close] match ${this.matchId} slot ${slot}: timed out, no input for ${TIMEOUT_TICKS} ticks`);
        seat.close("timed out");
        this.seats[slot] = null;
        continue;
      }

      // Drain one input, or two once the client has stayed ahead of us for
      // OVER_TARGET_TICKS, which keeps the buffer near target without ever
      // inventing motion.
      if (seat.queue.length > BUFFER_TARGET) this.overTarget[slot]++;
      else this.overTarget[slot] = 0;
      const drain = this.overTarget[slot] >= OVER_TARGET_TICKS ? 2 : 1;
      let used: Input | null = null;
      for (let i = 0; i < drain && seat.queue.length > 0; i++) {
        used = seat.queue.shift()!;
        seat.ack = used.tick;
      }
      if (used && used.fire === 1) this.counters.fireTicks[slot]++;
      inputs[slot] = used;
    }

    const hits: HitEvent[] = [];
    step(this.world, inputs, hits);
    this.log.ticks.push({ tick, inputs });

    if (tick % PING_EVERY === 0) {
      for (const seat of this.seats) {
        if (!seat || seat.bot) continue;
        seat.pingId = tick + 1;
        seat.pingSentAt = Date.now();
        seat.send({ t: "ping", id: seat.pingId });
      }
    }

    if (tick % SNAPSHOT_EVERY === 0 || hits.length > 0) {
      this.broadcast(hits);
    }
    if (this.world.tick >= ROUND_TICKS) {
      this.finish();
    }
  }

  /* -------------------------------------------------------- broadcast --- */

  private broadcast(hits: HitEvent[]): void {
    const tick = this.world.tick;
    const players: SnapshotPlayer[] = this.world.players.map((p, slot) => ({
      s: slot,
      x: round3(p.x),
      z: round3(p.z),
      e: round3(p.y),
      w: round3(p.vy),
      u: round3(p.vx),
      v: round3(p.vz),
      y: p.yaw,
      p: quantPitch(p.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : p.pitch),
      h: p.hp,
      k: p.kills,
      d: p.deaths,
      a: p.alive ? 1 : 0,
      g: p.weapon,
      m: p.ammo[p.weapon],
      r: p.reloadUntil > 0 ? p.reloadUntil - tick : 0,
      // Whether this player fired during the window this snapshot covers, so
      // every client can show a muzzle flash and a tracer for someone else's
      // shot and not only for the ones that hit.
      f: tick - p.lastFireTick <= this.sinceLastSnap ? 1 : 0,
    }));

    for (const seat of this.seats) {
      if (!seat) continue;
      seat.send({
        t: "snap",
        tick,
        ack: seat.ack,
        rtt: Math.round(seat.rtt),
        players,
        hits,
      });
    }
    this.lastSnapTick = tick;
  }

  /** Ticks since the previous snapshot, for the fired flag above. */
  private get sinceLastSnap(): number {
    const d = this.world.tick - this.lastSnapTick;
    return d < 1 ? 1 : d;
  }

  /* ----------------------------------------------------------- finish --- */

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();

    const standings = this.standings();
    this.log.standings = standings;
    // The reveal. Hashed into the log, so the payout's log hash covers it.
    const salt = toHex(this.spreadSalt);
    this.log.spreadSalt = salt;
    const hash = createHash("sha256").update(canonicalise(this.log)).digest("hex");

    for (const seat of this.seats) {
      if (!seat) continue;
      seat.send({
        t: "over", tick: this.world.tick, standings, logHash: hash, spreadSalt: salt,
      });
    }
    // One line per match: how the shooting went, from the server's side.
    // Shots requested are applied inputs with the trigger down, so for an
    // automatic they outnumber shots by the fire interval; the ones to
    // watch are rewindClamped and coverRefused against hits, and
    // rejectedInputs and reconnects.
    console.log(`[match] ${this.matchId} over at tick ${this.world.tick}: ${JSON.stringify(this.report())}`);
    this.onFinish(this.log, hash);
  }

  /**
   * The finishing order, from the shared rule in protocol.ts. Shared so that
   * a replay orders the match with the same code rather than its own reading
   * of it.
   */
  private standings(): Standing[] {
    return standingsFrom(this.world.players, this.roster);
  }
}

/** Snapshot positions do not need full precision. Three decimals is 1 mm. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
