import { createHash } from "node:crypto";
import {
  MAP_ID,
  ROUND_TICKS,
  SNAPSHOT_EVERY,
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
  type MatchLog,
  type RosterEntry,
  type SnapshotPlayer,
  type Standing,
} from "../../shared/protocol";
import { PITCH_LIMIT } from "../../shared/sim";
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
}

export class Room {
  readonly matchId: string;
  readonly kind: RoomKind;
  readonly roster: RosterEntry[];
  readonly world: WorldState;

  private seats: (Seat | null)[];
  private bots: (Bot | null)[];
  /** Consecutive ticks each slot's queue has been above BUFFER_TARGET. */
  private overTarget: number[];
  private log: MatchLog;
  private timer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private startedAt = 0;
  private started = false;
  private finished = false;
  private onFinish: (log: MatchLog, hash: string) => void;
  private startWhenSeated: number;
  private fillWithBots: boolean;

  /**
   * `startWhenSeated` of 0 means the caller starts the clock. Anything higher
   * starts it automatically once that many seats are connected, so a dev round
   * does not burn its 90 seconds before the second tab has joined.
   *
   * `fillWithBots` seats a bot in every empty slot at the moment the round
   * starts. Free rooms only.
   */
  constructor(
    matchId: string,
    roster: RosterEntry[],
    onFinish: (log: MatchLog, hash: string) => void,
    startWhenSeated = 0,
    kind: RoomKind = "staked",
    fillWithBots = false,
  ) {
    this.matchId = matchId;
    this.kind = kind;
    this.roster = roster;
    this.world = createWorld(roster.length);
    this.seats = new Array(roster.length).fill(null);
    this.bots = new Array(roster.length).fill(null);
    this.overTarget = new Array(roster.length).fill(0);
    this.onFinish = onFinish;
    this.startWhenSeated = startWhenSeated;
    this.fillWithBots = fillWithBots && kind === "free";
    this.log = {
      v: 2,
      matchId,
      map: MAP_ID,
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
    };
  }

  /** Fill every empty slot with a bot. Free rooms only, same refusal. */
  fillBots(): void {
    for (let slot = 0; slot < this.roster.length; slot++) {
      if (!this.seats[slot]) this.addBot(slot);
    }
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

    for (const inp of batch) {
      if (inp.tick <= seat.ack) continue;
      if (seat.queue.length >= BUFFER_MAX) break;
      if (seat.queue.some((q) => q.tick === inp.tick)) continue;
      seat.queue.push(inp);
    }
    seat.queue.sort((a, b) => a.tick - b.tick);
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
      inputs[slot] = used;
    }

    const hits: HitEvent[] = [];
    step(this.world, inputs, hits);
    this.log.ticks.push({ tick, inputs });

    if (tick % SNAPSHOT_EVERY === 0 || hits.length > 0) {
      this.broadcast(hits);
    }
    if (this.world.tick >= ROUND_TICKS) {
      this.finish();
    }
  }

  /* -------------------------------------------------------- broadcast --- */

  private broadcast(hits: HitEvent[]): void {
    const players: SnapshotPlayer[] = this.world.players.map((p, slot) => ({
      s: slot,
      x: round3(p.x),
      z: round3(p.z),
      e: round3(p.y),
      w: round3(p.vy),
      y: p.yaw,
      p: quantPitch(p.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : p.pitch),
      h: p.hp,
      k: p.kills,
      d: p.deaths,
      a: p.alive ? 1 : 0,
    }));

    for (const seat of this.seats) {
      if (!seat) continue;
      seat.send({
        t: "snap",
        tick: this.world.tick,
        ack: seat.ack,
        players,
        hits,
      });
    }
  }

  /* ----------------------------------------------------------- finish --- */

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();

    const standings = this.standings();
    this.log.standings = standings;
    const hash = createHash("sha256").update(canonicalise(this.log)).digest("hex");

    for (const seat of this.seats) {
      if (!seat) continue;
      seat.send({ t: "over", tick: this.world.tick, standings, logHash: hash });
    }
    this.onFinish(this.log, hash);
  }

  /**
   * Ordering must be total and deterministic, because it decides who gets paid.
   * Kills descending, then fewer deaths, then lower slot. Slot is the final
   * tiebreak precisely because it can never tie, which means there is no case
   * where the standings depend on iteration order or timing.
   */
  private standings(): Standing[] {
    const rows = this.world.players.map((p, slot) => ({
      slot,
      wallet: this.roster[slot].wallet,
      kills: p.kills,
      deaths: p.deaths,
      place: 0,
    }));
    rows.sort((a, b) =>
      b.kills - a.kills || a.deaths - b.deaths || a.slot - b.slot,
    );
    rows.forEach((r, i) => { r.place = i + 1; });
    return rows;
  }
}

/** Snapshot positions do not need full precision. Three decimals is 1 mm. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
