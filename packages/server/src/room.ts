import { createHash } from "node:crypto";
import {
  MAP_SEED,
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

/** How far ahead of the server a client may buffer before we drain faster. */
const BUFFER_TARGET = 2;
const BUFFER_MAX = 8;

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
}

export class Room {
  readonly matchId: string;
  readonly roster: RosterEntry[];
  readonly world: WorldState;

  private seats: (Seat | null)[];
  private log: MatchLog;
  private timer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private startedAt = 0;
  private finished = false;
  private onFinish: (log: MatchLog, hash: string) => void;

  constructor(
    matchId: string,
    roster: RosterEntry[],
    onFinish: (log: MatchLog, hash: string) => void,
  ) {
    this.matchId = matchId;
    this.roster = roster;
    this.world = createWorld(roster.length);
    this.seats = new Array(roster.length).fill(null);
    this.onFinish = onFinish;
    this.log = {
      v: 1,
      matchId,
      mapSeed: MAP_SEED,
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
    const existing = this.seats[seat.slot];
    if (existing) {
      // A second socket for the same wallet. Keep the new one and drop the old,
      // so a player whose phone dropped can rejoin, but never run two at once.
      existing.close("replaced by a newer connection");
    }
    this.seats[seat.slot] = seat;
    seat.lastSeenTick = this.world.tick;
  }

  unseat(slot: number): void {
    this.seats[slot] = null;
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
    this.startedAt = Date.now();
    this.log.startedAt = this.startedAt;
    this.nextTickAt = this.startedAt;
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

    for (let slot = 0; slot < this.seats.length; slot++) {
      const seat = this.seats[slot];
      if (!seat) continue;

      if (tick - seat.lastSeenTick > TIMEOUT_TICKS) {
        seat.close("timed out");
        this.seats[slot] = null;
        continue;
      }

      // Drain one input, or two when the client has run ahead of us, which
      // keeps the buffer near target without ever inventing motion.
      const drain = seat.queue.length > BUFFER_TARGET ? 2 : 1;
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
      y: p.yaw,
      p: quantPitch(p.pitch < -PITCH_LIMIT ? -PITCH_LIMIT : p.pitch),
      h: p.hp,
      k: p.kills,
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
