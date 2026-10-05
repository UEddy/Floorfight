import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  MAX_INPUTS_PER_BATCH,
  MAX_MSGS_PER_SECOND,
  MAX_MSG_BYTES,
  NONCE_TTL_MS,
  PROTOCOL_VERSION,
  isWellFormedInput,
  joinMessage,
  type ClientMsg,
  type RosterEntry,
} from "../../shared/protocol";
import { DEV_MATCH_ID, DEV_MIN_SEATED } from "../../shared/dev";
import { devModeFromEnv, devRoster, devWarning } from "./dev";
import { hasChainEnv, rosterFromMatch } from "./chain";
import type { ChainConfig } from "./chainrpc";
import { DEFAULT_LOG_DIR, finishMatch } from "./settlement";
import { FREE_SEAT_OPEN, Room, type RoomKind, type Seat } from "./room";
import {
  ConnectionLimits,
  JOIN_DEADLINE_MS,
  MAX_CONNECTIONS,
  MAX_FREE_ROOMS,
  MAX_PER_IP,
  MAX_ROOMS,
  clientIp,
  limitFromEnv,
} from "./limits";

/**
 * Loopback by default. In deployment Caddy terminates TLS and proxies /ws to
 * this port, so nothing else should reach it directly. Listening on every
 * interface takes an explicit HOST=0.0.0.0, never a default.
 */
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8080);

/**
 * Caps, read once. The defaults in limits.ts are the policy; the environment
 * overrides exist so a test does not have to open two hundred sockets or wait
 * ten seconds for a deadline.
 */
const LIMIT_PER_IP = limitFromEnv(process.env, "MAX_PER_IP", MAX_PER_IP);
const LIMIT_TOTAL = limitFromEnv(process.env, "MAX_CONNECTIONS", MAX_CONNECTIONS);
const LIMIT_ROOMS = limitFromEnv(process.env, "MAX_ROOMS", MAX_ROOMS);
const LIMIT_FREE_ROOMS = Math.min(
  LIMIT_ROOMS, limitFromEnv(process.env, "MAX_FREE_ROOMS", MAX_FREE_ROOMS),
);
const JOIN_DEADLINE = limitFromEnv(process.env, "JOIN_DEADLINE_MS", JOIN_DEADLINE_MS);
const limits = new ConnectionLimits(LIMIT_PER_IP, LIMIT_TOTAL);

let DEV = false;
const LOG_DIR = process.env.LOG_DIR || DEFAULT_LOG_DIR;
try {
  DEV = devModeFromEnv(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

/**
 * The chain, if this server has one.
 *
 * Loaded dynamically, so a free only server never imports @solana/web3.js.
 * That is seconds of startup and a good chunk of heap on a 512 MB droplet
 * that would buy nothing: with no resolver key there is no staked room to
 * open and nothing to settle.
 */
let CHAIN: ChainConfig | null = null;
let rpc: typeof import("./chainrpc") | null = null;
try {
  if (hasChainEnv(process.env)) {
    const loaded = await import("./chainrpc");
    // Throws rather than warns on a half configured chain, on a resolver key
    // anyone can read, and on dev mode sharing a box with that key.
    CHAIN = loaded.chainFromEnv(process.env, DEV);
    rpc = loaded;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

/**
 * Match registry.
 *
 * In production a match is created on chain first and this reads the roster
 * from the escrow account, so the set of people allowed into a room is exactly
 * the set of people who staked. For local development a room can be opened
 * with a roster supplied by hand, but that path must never be reachable in the
 * deployed build: it would let anyone join a funded match.
 */
const rooms = new Map<string, Room>();

/** Public keys of the six dev seats. Refused at join unless DEV is on. */
const DEV_WALLETS = new Set(devRoster().map((r) => r.wallet));

export interface RoomOptions {
  startWhenSeated?: number;
  kind?: RoomKind;
  fillWithBots?: boolean;
  fillAfterMs?: number;
  /** Start the clock as soon as the room opens. */
  startNow?: boolean;
  /** Set for a staked match: what to settle, and how many players. */
  staked?: { matchId: bigint; count: number };
  onDone?: () => void;
}

/**
 * Open a room.
 *
 * `kind` defaults to staked, which is the safe default: a caller that forgets
 * to say gets a room that refuses to seat bots rather than one that allows
 * them. `fillWithBots` and `fillAfterMs` only do anything in a free room.
 */
export function openRoom(
  matchId: string,
  roster: RosterEntry[],
  opts: RoomOptions = {},
): Room {
  const room = new Room(matchId, roster, (log, hash) => {
    console.log(`[match ${matchId}] finished, log hash ${hash}`);
    void finishMatch(log, hash, {
      logDir: LOG_DIR,
      staked: opts.staked ?? null,
      settle: CHAIN && rpc
        ? (id, placements, logHash) => rpc!.settleWithRetry(CHAIN!, id, placements, logHash)
        : undefined,
    }).catch((e: unknown) => {
      // Logged loudly and left there. A staked match that cannot be settled
      // refunds on its deadline, which is the outcome the program is built to
      // guarantee without anyone having to intervene.
      console.error(`[match ${matchId}] finishing failed: ${(e as Error).message}`);
    });
    opts.onDone?.();
  }, opts.startWhenSeated ?? 0, opts.kind ?? "staked",
    opts.fillWithBots ?? false, opts.fillAfterMs ?? 0);
  rooms.set(matchId, room);
  if (opts.startNow) room.start();
  return room;
}

/* --------------------------------------------------------- staked rooms --- */

/** Match ids that could be an on-chain u64. Nothing else is looked up. */
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;

/**
 * Ids recently looked up and not found, so that a stream of joins naming
 * random numbers cannot turn into a stream of RPC calls. Short lived, because
 * a match that is not Locked yet may be a moment later.
 */
const missed = new Map<string, number>();
const MISS_TTL_MS = 10_000;
/** Bounded, so a stream of made up ids cannot grow this forever. */
const MISS_MAX = 1000;
const opening = new Set<string>();

/**
 * Open a staked room for a match that is already Locked on chain.
 *
 * Locked is the only state that can become a room. Open means people are
 * still joining and the roster is not final; Settled and Refunding mean the
 * money has already moved. Taking the roster from the account in slot order
 * is what makes the placements the resolver submits mean the same thing as
 * the slots the simulation used.
 *
 * Rooms open on demand, when the first participant asks to join one, so there
 * is no admin endpoint to secure and no list to keep in step with the chain.
 * The chain is the list.
 */
async function ensureStakedRoom(matchId: string): Promise<Room | null> {
  if (!CHAIN || !rpc || !U64_RE.test(matchId)) return null;
  const existing = rooms.get(matchId);
  if (existing) return existing;

  const missedAt = missed.get(matchId);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null;
  if (opening.has(matchId)) return null;

  opening.add(matchId);
  try {
    const account = await rpc.fetchMatch(CHAIN, BigInt(matchId));
    if (!account) {
      if (missed.size >= MISS_MAX) missed.clear();
      missed.set(matchId, Date.now());
      return null;
    }
    if (account.state !== "Locked") {
      console.warn(`[match ${matchId}] is ${account.state}, not Locked: no room`);
      if (missed.size >= MISS_MAX) missed.clear();
      missed.set(matchId, Date.now());
      return null;
    }
    // A second connection may have opened it while this one was on the RPC.
    const raced = rooms.get(matchId);
    if (raced) return raced;

    if (rooms.size >= LIMIT_ROOMS) {
      // Should not happen: free rooms are capped below the total so there is
      // always headroom for a staked match. Loud if it ever does, because the
      // people in that match have stakes in escrow.
      console.error(
        `[match ${matchId}] cannot open a staked room: ${rooms.size} rooms already open`,
      );
      return null;
    }

    const roster = rosterFromMatch(account);
    console.log(
      `[match ${matchId}] opening staked room, ${roster.length} players, ` +
      `stake ${account.stake} lamports each`,
    );
    return openRoom(matchId, roster, {
      kind: "staked",
      startWhenSeated: roster.length,
      staked: { matchId: BigInt(matchId), count: account.count },
      onDone: () => { rooms.delete(matchId); },
    });
  } finally {
    opening.delete(matchId);
  }
}

/* ---------------------------------------------------------- free rooms --- */

/**
 * Free play.
 *
 * One room is always open and offered to anyone connecting. It waits a few
 * seconds for other people, fills whatever is left with bots and starts, so a
 * single player never sits in an empty hall. When a room has all six seats
 * taken by real players, the next one opens behind it.
 *
 * Match ids carry the boot time so that a restart cannot reuse an id and
 * overwrite the match log of a round that already happened.
 */
const FREE_SEATS = 6;
const FREE_FILL_MS = Number(process.env.FREE_FILL_MS ?? 8000);
const BOOT = Date.now().toString(36);
let freeCounter = 0;
const freeRooms: Room[] = [];

function openFreeRoom(): Room | null {
  // Free play gets a share of the room cap, never all of it: a staked match
  // has money in escrow and must not be the thing that cannot open.
  if (freeRooms.length >= LIMIT_FREE_ROOMS || rooms.size >= LIMIT_ROOMS) {
    console.warn(
      `[free] at capacity: ${freeRooms.length} free rooms, ${rooms.size} rooms in total`,
    );
    return null;
  }
  const matchId = `free-${BOOT}-${++freeCounter}`;
  const roster: RosterEntry[] = [];
  for (let slot = 0; slot < FREE_SEATS; slot++) {
    roster.push({ slot, wallet: FREE_SEAT_OPEN, collection: null, mint: null });
  }
  const room = openRoom(matchId, roster, {
    kind: "free",
    fillWithBots: true,
    fillAfterMs: FREE_FILL_MS,
    onDone: () => {
      rooms.delete(matchId);
      const i = freeRooms.indexOf(room);
      if (i >= 0) freeRooms.splice(i, 1);
    },
  });
  freeRooms.push(room);
  console.log(`[free] opened ${matchId}`);
  return room;
}

/**
 * The newest free room worth joining, opening one if there is none.
 *
 * Null when the box is at its room cap and every room already open is full or
 * nearly over. The challenge then offers no free room, and the client says so
 * rather than joining something that cannot seat it.
 */
function matchmake(): Room | null {
  for (let i = freeRooms.length - 1; i >= 0; i--) {
    if (freeRooms[i].joinable()) return freeRooms[i];
  }
  return openFreeRoom();
}

/**
 * Dev only. Reached solely through the DEV flag, which devModeFromEnv never
 * sets in production. When a round ends a fresh room replaces it, so tabs can
 * reload and play again without restarting the server.
 */
function openDevRoom(): void {
  // Fixed seats and known keys, which is what makes two tabs side by side
  // useful. Bots fill the rest when it starts.
  openRoom(DEV_MATCH_ID, devRoster(), {
    kind: "free",
    fillWithBots: true,
    startWhenSeated: DEV_MIN_SEATED,
    onDone: () => { setTimeout(openDevRoom, 3000); },
  });
  console.warn(`[dev] room "${DEV_MATCH_ID}" open, starts when ${DEV_MIN_SEATED} players join, bots fill the rest`);
}

/* ------------------------------------------------------------- socket --- */

interface Pending {
  nonce: string;
  issuedAt: number;
  used: boolean;
}

const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const kick = (reason: string) => {
    try { ws.send(JSON.stringify({ t: "kick", reason })); } catch { /* closing */ }
    ws.close();
  };

  /*
   * Who is this, and are they allowed another socket?
   *
   * Behind Caddy the TCP peer is always the loopback, so the address that
   * matters comes out of X-Forwarded-For, and only when the peer really is
   * the loopback. See limits.ts for why the rightmost entry is the one used.
   */
  const ip = clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
  const verdict = limits.admit(ip);
  if (verdict !== "ok") {
    console.warn(
      `[limits] refused ${ip}: ${verdict} ` +
      `(${limits.countFor(ip)} from it, ${limits.total} live)`,
    );
    kick(verdict);
    return;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    limits.release(ip);
  };

  const pending: Pending = {
    nonce: bs58.encode(randomBytes(24)),
    issuedAt: Date.now(),
    used: false,
  };

  let room: Room | null = null;
  let slot = -1;
  let mySeat: Seat | null = null;
  let budget = MAX_MSGS_PER_SECOND;
  const refill = setInterval(() => { budget = MAX_MSGS_PER_SECOND; }, 1000);

  /*
   * A socket that never joins is a socket holding a slot for nothing. Ten
   * seconds is far longer than the handshake takes and short enough that a
   * script opening connections and sitting on them gets nowhere.
   */
  let joinTimer: NodeJS.Timeout | null = setTimeout(() => {
    joinTimer = null;
    if (room) return;
    console.warn(`[limits] ${ip} connected without joining, closing`);
    kick("join timed out");
  }, JOIN_DEADLINE);
  const clearJoinTimer = () => {
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = null;
  };

  // The free room this connection would sit in, decided now so the guest can
  // sign the id of the room it actually gets. Null when every room is full
  // and the box is at its cap.
  const offered = matchmake();
  ws.send(JSON.stringify({
    t: "challenge",
    v: PROTOCOL_VERSION,
    nonce: pending.nonce,
    freeMatchId: offered ? offered.matchId : null,
  }));

  ws.on("message", (raw) => {
    if (budget-- <= 0) return kick("too many messages");

    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return kick("malformed message");
    }
    if (typeof msg !== "object" || msg === null) return kick("malformed message");

    if (msg.t === "join") {
      if (room) return kick("already joined");
      void handleJoin(msg).catch(() => kick("join failed"));
      return;
    }

    if (!room || slot < 0) return kick("not joined");

    if (msg.t === "input") {
      if (!Array.isArray(msg.batch)) return kick("malformed input");
      if (msg.batch.length > MAX_INPUTS_PER_BATCH) return kick("oversized batch");
      // Anything that is not a finite number would poison the simulation, so
      // the whole batch is discarded rather than partially applied.
      for (const inp of msg.batch) {
        if (!isWellFormedInput(inp)) return kick("malformed input");
      }
      room.acceptInputs(slot, msg.batch);
      return;
    }

    if (msg.t === "pong") {
      if (typeof msg.id === "number" && Number.isFinite(msg.id)) {
        room.pong(slot, msg.id);
      }
      return;
    }
    return kick("unknown message");
  });

  ws.on("close", () => {
    clearInterval(refill);
    clearJoinTimer();
    release();
    if (room && mySeat) room.unseat(slot, mySeat);
  });

  async function handleJoin(msg: Extract<ClientMsg, { t: "join" }>): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) return kick("protocol version mismatch");
    if (pending.used) return kick("nonce already used");
    if (Date.now() - pending.issuedAt > NONCE_TTL_MS) return kick("challenge expired");

    // The dev keys are public by design, so outside dev mode they must never
    // get a seat, whatever roster a bug or a bad config might put them on.
    // Checked before anything else about the match, so the refusal does not
    // depend on which rooms happen to exist.
    if (!DEV && DEV_WALLETS.has(msg.wallet)) return kick("dev key");

    /*
     * The signature comes first, before any seat is allocated and before any
     * RPC call.
     *
     * It has to: in a free room the signature is the whole of the admission
     * test, and checking it afterwards would let an unsigned connection
     * consume a slot. It also proves the wallet string is a real 32 byte
     * public key, which is what stops anyone claiming the placeholder names a
     * free roster uses for empty and bot seats.
     */
    let ok = false;
    try {
      const pubkey = bs58.decode(msg.wallet);
      const sig = bs58.decode(msg.sig);
      if (pubkey.length !== 32 || sig.length !== 64) return kick("bad credentials");
      const message = new TextEncoder().encode(joinMessage(msg.matchId, pending.nonce));
      ok = nacl.sign.detached.verify(message, sig, pubkey);
    } catch {
      return kick("bad credentials");
    }
    if (!ok) return kick("bad signature");

    // Burn the nonce before anything slow happens, so two joins racing on one
    // challenge cannot both get through.
    pending.used = true;

    // A staked room opens the first time one of its participants asks for it,
    // and only if the chain says the match is Locked.
    const target = rooms.get(msg.matchId) ?? await ensureStakedRoom(msg.matchId);
    if (!target) return kick("no such match");

    let entry: RosterEntry | undefined;
    if (target.kind === "free") {
      // Any key that signed the nonce gets a seat, in join order.
      const claimed = target.claimFreeSeat(msg.wallet);
      if (claimed === null) return kick("that room filled up, reconnect for another");
      entry = target.roster[claimed];
    } else {
      // The roster is the allow list. A wallet that did not stake has no
      // seat, whatever it signs, and its slot is the one the chain gave it.
      entry = target.roster.find((r) => r.wallet === msg.wallet);
      if (!entry) return kick("not a participant in this match");
    }

    // Cosmetic only, and deliberately non-fatal. A wallet that no longer holds
    // the mint it registered plays as the default character rather than being
    // refused a seat it paid for.
    entry.collection = await verifyCharacter(msg.wallet, entry.mint);

    room = target;
    slot = entry.slot;

    const seat: Seat = {
      slot,
      wallet: msg.wallet,
      queue: [],
      ack: -1,
      lastSeenTick: 0,
      pingId: 0,
      pingSentAt: 0,
      rtt: 0,
      send: (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
      close: (reason) => kick(reason),
    };
    mySeat = seat;
    clearJoinTimer();
    target.seat(seat);

    ws.send(JSON.stringify({
      t: "accepted",
      slot,
      tick: target.world.tick,
      startsInMs: 0,
      roster: target.roster,
      // The commit half of the spread salt. A staked room drew it at
      // creation; the reveal arrives when the match ends.
      spreadCommit: target.spreadCommit,
    }));

    // A room with every seat taken by a real player is a room nobody else can
    // join, so the next one opens behind it.
    if (target.kind === "free" && target.freeSeats() === 0) openFreeRoom();
  }
});

/**
 * Resolve which character a wallet may wear.
 *
 * Returns the verified collection address, or null for the default skin. The
 * client's claim is never taken at face value: ownership is read from the
 * chain here, and the result is what the roster carries into the match log.
 *
 * Stub until the RPC endpoint is wired. Returning null is the safe default,
 * because the failure mode is a plain character rather than a wrong one.
 */
async function verifyCharacter(
  _wallet: string,
  _mint: string | null,
): Promise<string | null> {
  return null;
}

wss.on("listening", () => {
  console.log(`floorfight server listening on ${HOST}:${PORT}`);
  console.log(
    `caps: ${LIMIT_PER_IP} sockets per address, ${LIMIT_TOTAL} in total, ` +
    `${LIMIT_ROOMS} rooms (${LIMIT_FREE_ROOMS} free), ` +
    `${JOIN_DEADLINE} ms to join`,
  );
  console.log(`match logs in ${LOG_DIR}`);
  if (CHAIN) {
    console.log(
      `staked rooms on ${CHAIN.rpcUrl}, program ${CHAIN.programId.toBase58()}, ` +
      `resolver ${CHAIN.resolver.publicKey.toBase58()}`,
    );
  } else {
    console.log("no chain configuration: free rooms only");
  }
});

if (DEV) {
  console.warn(devWarning());
  openDevRoom();
}

// One free room always open, so the first connection has somewhere to go.
openFreeRoom();
