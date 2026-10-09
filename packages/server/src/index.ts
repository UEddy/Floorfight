import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  MAX_INPUTS_PER_BATCH,
  MAX_MSGS_PER_SECOND,
  MAX_MSG_BURST,
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
import { hasChainEnv, parseMatchRef, rosterFromMatch, type MatchRef } from "./chain";
import type { ChainConfig } from "./chainrpc";
import { DEFAULT_LOG_DIR, finishMatch } from "./settlement";
import { TtlCache, createApi } from "./api";
import { nftsFromEnv, type NftService } from "./nft";
import { skrFromEnv, type SkrService } from "./skr";
import { LOUNGE_MIN_TIER, SKR_TIERS } from "../../shared/skr";
import { Lobbies, type Member } from "./lobby";
import type { MatchAccount } from "./chain";
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
  MessageBudget,
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
  staked?: { ref: MatchRef; count: number };
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
  const staked = opts.staked;
  const room = new Room(matchId, roster, (log, hash) => {
    console.log(`[match ${matchId}] finished, log hash ${hash}`);
    void finishMatch(log, hash, {
      logDir: LOG_DIR,
      staked: staked ? { matchId: staked.ref.id, count: staked.count } : null,
      // The ref, not the bare id, goes to the chain: the id alone does not
      // say which escrow (SOL or token) the match is in.
      settle: CHAIN && rpc && staked
        ? (_id, placements, logHash) => rpc!.settleWithRetry(CHAIN!, staked.ref, placements, logHash)
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
async function ensureStakedRoom(
  matchId: string, known?: MatchAccount,
): Promise<Room | null> {
  // Only the two exact id forms (a u64, or "skr-" and a u64) are looked up.
  const ref = CHAIN && rpc ? parseMatchRef(matchId) : null;
  if (!CHAIN || !rpc || !ref) return null;
  const existing = rooms.get(matchId);
  if (existing) return existing;

  const missedAt = missed.get(matchId);
  if (!known && missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null;
  if (opening.has(matchId)) return null;

  opening.add(matchId);
  try {
    const account = known ?? await rpc.fetchMatch(CHAIN, ref);
    if (!account) {
      if (missed.size >= MISS_MAX) missed.clear();
      missed.set(matchId, Date.now());
      return null;
    }
    // Not cached as a miss: an Open match is one the lobby is about to lock,
    // and a refusal cached here would stop its room opening for ten seconds.
    if (account.state !== "Locked") return null;
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
      account.currency === "sol"
        ? `stake ${account.stake} lamports each`
        : `stake ${account.stake} raw units of ${account.mint} each`,
    );
    const room = openRoom(matchId, roster, {
      kind: "staked",
      startWhenSeated: roster.length,
      staked: { ref, count: account.count },
      onDone: () => { rooms.delete(matchId); },
    });

    /*
     * A staked room starts when everyone on the roster is connected. When the
     * lobby locked on the deadline rule, some of them may never come, so after
     * a grace period it starts with whoever is there. Never with bots: an
     * absent player's slot stands still for the round. A room nobody ever
     * joins is closed, and the match refunds on its settle deadline.
     */
    setTimeout(() => {
      if (room.isStarted || room.isFinished) return;
      if (room.seatedCount() > 0) {
        console.warn(`[match ${matchId}] starting with ${room.seatedCount()} of ${roster.length} connected`);
        room.start();
      }
    }, STAKED_START_GRACE_MS).unref();
    setTimeout(() => {
      if (room.isStarted || room.isFinished) return;
      console.error(`[match ${matchId}] nobody came: closing the room, the match will refund`);
      room.stop();
      rooms.delete(matchId);
    }, STAKED_ABANDON_MS).unref();
    return room;
  } finally {
    opening.delete(matchId);
  }
}

/** How long a staked room waits for absent players before starting without them. */
const STAKED_START_GRACE_MS = 20_000;
/** How long a staked room with nobody in it stays open before it is closed. */
const STAKED_ABANDON_MS = 5 * 60_000;

/* ---------------------------------------------------------------- NFTs --- */

/**
 * NFT heads. Needs HELIUS_API_KEY in the environment; without it the NFT
 * endpoints answer 503 and every holder plays with the default face. The key
 * never leaves this process.
 */
let NFTS: NftService | null = null;
try {
  NFTS = nftsFromEnv(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
/* ----------------------------------------------------------------- SKR --- */

/**
 * SKR badges and the lounge. Needs RPC_URL_MAINNET or HELIUS_API_KEY;
 * without either there are no badges and no lounge, and nothing else
 * changes. The URL and any key in it never leave this process.
 */
let SKR: SkrService | null = null;
try {
  SKR = skrFromEnv(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

/**
 * A wallet's badge tier, read after it has signed a join. Never throws and
 * never holds a join up for long (see SkrService.tierAtJoin).
 */
async function skrTierFor(wallet: string, ip: string): Promise<number> {
  if (!SKR) return 0;
  const tier = await SKR.tierAtJoin(wallet, ip);
  if (tier > 0) console.log(`[skr] ${wallet} holds tier ${tier}`);
  return tier;
}

/** Ownership answers, for a minute, so a reconnect does not cost another DAS call. */
const verified = new TtlCache<{ mint: string | null; collection: string | null }>(60_000, 2000);

/* ------------------------------------------------------------- lobbies --- */

/**
 * The holders lobby. Only on a server with a chain: without one there is no
 * Open match to wait for. See lobby.ts for the lock rule.
 */
const lobbies = CHAIN && rpc
  ? new Lobbies({
      // The lobby only ever holds ids enterLobby parsed, so these parse.
      fetchMatch: (id) => rpc!.fetchMatch(CHAIN!, parseMatchRef(id)!),
      lockMatch: (id) => rpc!.lockMatch(CHAIN!, parseMatchRef(id)!),
      openRoom: async (id) => (await ensureStakedRoom(id)) !== null,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      log: (line) => console.log(line),
    })
  : null;

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
/**
 * The SKR lounge: free rooms that seat only wallets holding at least
 * LOUNGE_MIN_TIER of SKR, checked here at join from the mainnet balance.
 * Bots fill them like any free room. They share free play's room cap.
 */
const loungeRooms: Room[] = [];
let loungeCounter = 0;

function openFreeRoom(): Room | null {
  // Free play gets a share of the room cap, never all of it: a staked match
  // has money in escrow and must not be the thing that cannot open.
  if (freeRooms.length + loungeRooms.length >= LIMIT_FREE_ROOMS || rooms.size >= LIMIT_ROOMS) {
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

/** The newest joinable lounge room, opening one if needed. Null without SKR. */
function matchmakeLounge(): Room | null {
  if (!SKR) return null;
  for (let i = loungeRooms.length - 1; i >= 0; i--) {
    if (loungeRooms[i].joinable()) return loungeRooms[i];
  }
  if (freeRooms.length + loungeRooms.length >= LIMIT_FREE_ROOMS || rooms.size >= LIMIT_ROOMS) return null;
  const matchId = `lounge-${BOOT}-${++loungeCounter}`;
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
      const i = loungeRooms.indexOf(room);
      if (i >= 0) loungeRooms.splice(i, 1);
    },
  });
  loungeRooms.push(room);
  console.log(`[lounge] opened ${matchId}`);
  return room;
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

/**
 * One port for both: the read only /api endpoints over HTTP, and the game
 * socket as an upgrade on the same server. Caddy proxies /api and /ws here.
 */
const api = createApi({
  chain: CHAIN && rpc
    ? {
        listOpen: async (currency, stake) =>
          (await rpc!.listOpenMatches(CHAIN!, currency, stake)).map((m) => m.account),
        fetchMatch: (ref) => rpc!.fetchMatch(CHAIN!, ref),
        potDecimals: CHAIN.potMint ? () => rpc!.potMintDecimals(CHAIN!) : undefined,
      }
    : undefined,
  nfts: NFTS ?? undefined,
  skr: SKR ?? undefined,
});
const http = createServer((req, res) => {
  void api(req, res).then((handled) => {
    if (handled) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
});
const wss = new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES });
http.listen(PORT, HOST);

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  let room: Room | null = null;
  let slot = -1;
  let mySeat: Seat | null = null;
  /** Set while this socket waits in a holders lobby. */
  let inLobby: { matchId: string; member: Member } | null = null;

  /**
   * Every close the server starts goes through here, and every one is logged
   * with the reason and the seat, so a player who says they were dropped can
   * be matched to a line in the journal. The reason also goes to the client,
   * which shows it rather than a generic "connection lost".
   */
  let kicked: string | null = null;
  const kick = (reason: string) => {
    if (kicked === null) {
      kicked = reason;
      console.warn(`[close] ${where()}: kicked, ${reason}`);
    }
    try { ws.send(JSON.stringify({ t: "kick", reason })); } catch { /* closing */ }
    ws.close(4000, reason.slice(0, 100));
  };
  const where = () => room
    ? `match ${room.matchId} slot ${slot} from ${ip}`
    : inLobby ? `lobby ${inLobby.matchId} from ${ip}` : `unjoined from ${ip}`;

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

  const budget = new MessageBudget(MAX_MSGS_PER_SECOND, MAX_MSG_BURST, Date.now());

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
    loungeMatchId: SKR ? matchmakeLounge()?.matchId ?? null : null,
  }));

  ws.on("message", (raw) => {
    if (!budget.take(Date.now())) return kick("too many messages");

    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return kick("malformed message");
    }
    if (typeof msg !== "object" || msg === null) return kick("malformed message");

    if (msg.t === "join") {
      if (room || inLobby) return kick("already joined");
      void handleJoin(msg).catch(() => kick("join failed"));
      return;
    }

    if (!room || slot < 0) return kick("not joined");

    if (msg.t === "input") {
      if (!Array.isArray(msg.batch)) return kick("malformed input");
      if (msg.batch.length > MAX_INPUTS_PER_BATCH) {
        room.rejectBatch(slot, msg.batch.length);
        return kick(`oversized batch of ${msg.batch.length}`);
      }
      // Anything that is not a finite number would poison the simulation, so
      // the whole batch is discarded rather than partially applied.
      for (const inp of msg.batch) {
        if (!isWellFormedInput(inp)) {
          room.rejectBatch(slot, msg.batch.length);
          return kick("malformed input");
        }
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

  ws.on("close", (code: number, why: Buffer) => {
    // Closes the server did not start: the phone went away, the network
    // dropped it, or the page closed it. The code says which, roughly: 1000
    // or 1001 is the page, 1006 is a connection that died without a close
    // frame, which on mobile data is the usual one.
    if (kicked === null && (room || inLobby)) {
      console.warn(`[close] ${where()}: closed by peer, code ${code}${why.length ? ` ${why.toString()}` : ""}`);
    }
    clearJoinTimer();
    release();
    if (inLobby && lobbies) lobbies.remove(inLobby.matchId, inLobby.member);
    inLobby = null;
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
    if (!target) {
      // Not a room yet. If it is an Open holders match this wallet has staked
      // into, the socket waits in the lobby until the match locks.
      if (await enterLobby(msg)) return;
      return kick("no such match");
    }

    let entry: RosterEntry | undefined;
    if (target.kind === "free" && loungeRooms.includes(target)) {
      // The lounge: the wallet has signed, so its balance is worth reading.
      // Below the threshold, or if the read fails, it is not let in.
      const tier = await skrTierFor(msg.wallet, ip);
      if (tier < LOUNGE_MIN_TIER) {
        return kick(`the SKR lounge is for wallets holding ${SKR_TIERS[LOUNGE_MIN_TIER - 1].min} SKR or more`);
      }
      const claimed = target.claimFreeSeat(msg.wallet);
      if (claimed === null) return kick("that room filled up, reconnect for another");
      entry = target.roster[claimed];
      entry.skr = tier;
    } else if (target.kind === "free") {
      // Any key that signed the nonce gets a seat, in join order. Free play
      // signs with a guest key made up by the page, which never holds SKR,
      // so no balance is read for it.
      const claimed = target.claimFreeSeat(msg.wallet);
      if (claimed === null) return kick("that room filled up, reconnect for another");
      entry = target.roster[claimed];
      entry.skr = 0;
    } else {
      // The roster is the allow list. A wallet that did not stake has no
      // seat, whatever it signs, and its slot is the one the chain gave it.
      entry = target.roster.find((r) => r.wallet === msg.wallet);
      if (!entry) return kick("not a participant in this match");
      // Cosmetic only, and deliberately non-fatal. A wallet that does not
      // hold the mint it asks for plays as the default character rather than
      // being refused a seat it paid for.
      const [character, tier] = await Promise.all([
        verifyCharacter(msg.wallet, msg.mint),
        skrTierFor(msg.wallet, ip),
      ]);
      Object.assign(entry, character, { skr: tier });
    }
    takeSeat(target, entry);
  }

  /**
   * Put a signed socket in the lobby of an Open match its wallet is in. The
   * account is read here, not trusted from anywhere: the wallet has to be in
   * the first `count` players on chain.
   */
  async function enterLobby(msg: Extract<ClientMsg, { t: "join" }>): Promise<boolean> {
    const ref = parseMatchRef(msg.matchId);
    if (!lobbies || !CHAIN || !rpc || !ref) return false;
    let account: MatchAccount | null;
    try {
      account = await rpc.fetchMatch(CHAIN, ref);
    } catch {
      return false;
    }
    if (!account || account.state !== "Open") return false;
    if (!account.players.slice(0, account.count).includes(msg.wallet)) {
      kick("not a participant in this match");
      return true;
    }
    // Checked now, while the socket waits, so the room can seat it at once.
    const [character, tier] = await Promise.all([
      verifyCharacter(msg.wallet, msg.mint),
      skrTierFor(msg.wallet, ip),
    ]);
    const matchId = msg.matchId;
    const member: Member = {
      wallet: msg.wallet,
      send: (view) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(view)); },
      close: (reason) => kick(reason),
      enter: (id) => {
        inLobby = null;
        const r = rooms.get(id);
        const entry = r?.roster.find((e) => e.wallet === msg.wallet);
        if (!r || !entry) return kick("the room did not open");
        Object.assign(entry, character, { skr: tier });
        takeSeat(r, entry);
      },
    };
    if (!lobbies.add(matchId, account, member)) {
      kick("too many lobbies open, try again shortly");
      return true;
    }
    inLobby = { matchId, member };
    // Waiting in a lobby is not idling on the handshake: it can take
    // minutes, and the socket has already signed.
    clearJoinTimer();
    return true;
  }

  /** Seat this socket in a room, on the roster entry it was given. */
  function takeSeat(target: Room, entry: RosterEntry): void {
    room = target;
    slot = entry.slot;

    const seat: Seat = {
      slot,
      wallet: entry.wallet,
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
 * Returns the roster fields for the head: a verified mint and its collection,
 * or nulls for the default face. The client's request is never taken at face
 * value: ownership is checked server side, and the result is what the roster
 * carries into the match log. Never throws, because the failure mode has to
 * be a plain face rather than a refused seat.
 */
async function verifyCharacter(
  wallet: string,
  mint: string | undefined,
): Promise<{ mint: string | null; collection: string | null }> {
  if (!NFTS || typeof mint !== "string" || mint.length === 0 || mint.length > 64) {
    return { mint: null, collection: null };
  }
  const answer = await verified.get(`${wallet}:${mint}`, () => NFTS!.verify(wallet, mint));
  if (answer.mint) console.log(`[nft] ${wallet} wears ${answer.mint}`);
  return answer;
}

http.on("listening", () => {
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
    console.log(CHAIN.potMint
      ? `token pots in ${CHAIN.potMint.toBase58()} (Test SKR, devnet)`
      : "no SKR_POT_MINT: SOL pots only");
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
