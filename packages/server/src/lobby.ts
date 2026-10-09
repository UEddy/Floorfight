/**
 * The holders lobby: where players who have staked into an Open match wait
 * until it is locked and its room opens.
 *
 * Getting into the lobby is the ordinary join handshake: a signature over
 * the server's nonce and the match id, from a wallet the chain lists in that
 * match. Nothing about the lobby is decided by a client. Who is in the match
 * is read off the account, and when it locks is decided here, from two
 * things only: the account, and which of its wallets have a signed socket
 * open right now.
 *
 * The rule:
 *
 *   - at least two players have joined on chain, and
 *   - every one of them is here, or the join window has a minute or less
 *     left.
 *
 * Then the resolver sends lock_match, the staked room opens with the roster
 * the account holds, and everybody in the lobby is moved straight into it on
 * the same socket, so nobody signs twice. A staked room never takes a bot:
 * anyone who is not connected when it starts simply stands still.
 *
 * With fewer than two by the deadline nothing is locked and the match
 * refunds, which the program lets each player claim on their own.
 */

import { LOCK_BEFORE_DEADLINE } from "../../shared/tiers";
import { MIN_PLAYERS_TO_LOCK, type LobbyView } from "../../shared/protocol";
import type { MatchAccount } from "./chain";

export type LockDecision =
  /** Not enough players, or not everyone is here and there is time left. */
  | "wait"
  /** Send lock_match now. */
  | "lock"
  /** Already Locked on chain: open the room and move everyone in. */
  | "open-room"
  /** Join window closed without a lock: the match can only refund now. */
  | "expired"
  /** Settled or Refunding, or gone: nothing for a lobby to do. */
  | "over";

/**
 * The lock rule, as a pure function of the account, the wallets connected
 * in the lobby, and the time. Tested directly, and again against LiteSVM.
 */
export function lockDecision(
  account: MatchAccount | null, present: ReadonlySet<string>, nowSeconds: number,
): LockDecision {
  if (!account) return "over";
  if (account.state === "Locked") return "open-room";
  if (account.state !== "Open") return "over";
  // The program refuses lock_match once now > join_deadline.
  if (nowSeconds > account.joinDeadline) return "expired";
  if (account.count < MIN_PLAYERS_TO_LOCK) return "wait";
  const joined = account.players.slice(0, account.count);
  const everyoneHere = joined.every((w) => present.has(w));
  const late = account.joinDeadline - nowSeconds <= LOCK_BEFORE_DEADLINE;
  return everyoneHere || late ? "lock" : "wait";
}

/** One signed socket waiting in a lobby. */
export interface Member {
  wallet: string;
  /** Tell the client how the lobby stands. */
  send: (view: LobbyView) => void;
  /** Move this socket into the opened room. */
  enter: (matchId: string) => void;
  /** Close the socket with a reason. */
  close: (reason: string) => void;
}

export interface LobbyDeps {
  /** Both take the match id string: a bare number for SOL, "skr-" and a number for a token match. */
  fetchMatch: (matchId: string) => Promise<MatchAccount | null>;
  lockMatch: (matchId: string) => Promise<string>;
  /** Open the staked room for a Locked match. False if it could not be opened. */
  openRoom: (matchId: string) => Promise<boolean>;
  nowSeconds: () => number;
  log?: (line: string) => void;
}

/** How often each lobby with somebody in it asks the chain how it stands. */
export const POLL_MS = 3000;
/** Lobbies open at once. Each one costs an RPC call every POLL_MS. */
export const MAX_LOBBIES = 40;

interface Lobby {
  members: Set<Member>;
  /**
   * Set synchronously when a step starts and cleared when it ends, so the
   * step add() kicks off and a timer poll cannot both read the account,
   * both decide "lock" and both send lock_match.
   */
  busy: boolean;
  /** The step in progress, so a second caller can wait for it. */
  running: Promise<void> | null;
  last: MatchAccount | null;
}

export class Lobbies {
  private lobbies = new Map<string, Lobby>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private deps: LobbyDeps) {}

  get size(): number {
    return this.lobbies.size;
  }

  /**
   * Add a socket whose wallet the caller has already checked is in this
   * match on chain. Returns false if the server is at its lobby cap.
   */
  add(matchId: string, account: MatchAccount, member: Member): boolean {
    let lobby = this.lobbies.get(matchId);
    if (!lobby) {
      if (this.lobbies.size >= MAX_LOBBIES) return false;
      lobby = { members: new Set(), busy: false, running: null, last: account };
      this.lobbies.set(matchId, lobby);
    }
    // One socket per wallet. A reconnect replaces the old one.
    for (const m of lobby.members) {
      if (m.wallet === member.wallet) {
        lobby.members.delete(m);
        m.close("replaced by a newer connection");
      }
    }
    lobby.members.add(member);
    lobby.last = account;
    this.broadcast(matchId, lobby);
    this.ensureTimer();
    // React at once rather than at the next poll: the second player arriving
    // is usually the moment the match can lock.
    void this.step(matchId);
    return true;
  }

  remove(matchId: string, member: Member): void {
    const lobby = this.lobbies.get(matchId);
    if (!lobby) return;
    lobby.members.delete(member);
    if (lobby.members.size === 0 && !lobby.busy) this.lobbies.delete(matchId);
    else this.broadcast(matchId, lobby);
    if (this.lobbies.size === 0) this.stopTimer();
  }

  /** Poll every lobby once. Exposed for tests. */
  async pollAll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const id of [...this.lobbies.keys()]) await this.step(id);
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollAll(); }, POLL_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private present(lobby: Lobby): Set<string> {
    return new Set([...lobby.members].map((m) => m.wallet));
  }

  /** Look at one lobby's match and act on it. */
  async step(matchId: string): Promise<void> {
    const lobby = this.lobbies.get(matchId);
    if (!lobby) return;
    if (lobby.busy) return lobby.running ?? undefined;
    lobby.busy = true;
    lobby.running = this.stepLocked(matchId, lobby);
    try {
      await lobby.running;
    } finally {
      lobby.running = null;
      lobby.busy = false;
      // Everybody may have left while the step was on the network.
      if (lobby.members.size === 0 && this.lobbies.get(matchId) === lobby) {
        this.lobbies.delete(matchId);
      }
      if (this.lobbies.size === 0) this.stopTimer();
    }
  }

  private async stepLocked(matchId: string, lobby: Lobby): Promise<void> {
    let account: MatchAccount | null;
    try {
      account = await this.deps.fetchMatch(matchId);
    } catch (e) {
      this.deps.log?.(`[lobby ${matchId}] read failed: ${(e as Error).message}`);
      return;
    }
    lobby.last = account;
    const decision = lockDecision(account, this.present(lobby), this.deps.nowSeconds());

    if (decision === "wait") {
      this.broadcast(matchId, lobby);
      return;
    }
    if (decision === "expired" || decision === "over") {
      this.broadcast(matchId, lobby, decision);
      for (const m of lobby.members) m.close(decision === "expired"
        ? "the join window closed with fewer than two players: claim your refund"
        : "this match is over");
      this.lobbies.delete(matchId);
      return;
    }

    // Lock (if it is not already) and open the room. Only one step runs per
    // lobby at a time, so two polls cannot send two lock transactions.
    this.broadcast(matchId, lobby, "locking");
    try {
      if (decision === "lock") {
        const sig = await this.deps.lockMatch(matchId);
        this.deps.log?.(`[lobby ${matchId}] locked, ${sig}`);
      }
      const opened = await this.deps.openRoom(matchId);
      if (!opened) throw new Error("the room did not open");
      this.lobbies.delete(matchId);
      for (const m of lobby.members) m.enter(matchId);
    } catch (e) {
      // Usually a race: somebody else locked it, or it filled and locked
      // itself. The next poll reads the account again and does the right
      // thing from there.
      this.deps.log?.(`[lobby ${matchId}] lock or open failed: ${(e as Error).message}`);
    }
  }

  private broadcast(matchId: string, lobby: Lobby, phase?: LobbyView["phase"]): void {
    const a = lobby.last;
    const present = this.present(lobby);
    const view: LobbyView = {
      t: "lobby",
      matchId,
      phase: phase ?? "waiting",
      count: a?.count ?? 0,
      maxPlayers: a?.maxPlayers ?? 0,
      currency: a?.currency ?? "sol",
      stake: a ? a.stake.toString() : "0",
      joinDeadline: a?.joinDeadline ?? 0,
      // Which of the joined slots have a socket here. Slots, not wallets: the
      // wallets are public on chain anyway, but the page only needs a count.
      present: a ? a.players.slice(0, a.count).map((w) => present.has(w)) : [],
      lockBefore: LOCK_BEFORE_DEADLINE,
    };
    for (const m of lobby.members) m.send(view);
  }
}
