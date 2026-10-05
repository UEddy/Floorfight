import { randomBytes } from "node:crypto";
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
import { Room, type RoomKind, type Seat } from "./room";

/**
 * Loopback by default. In deployment Caddy terminates TLS and proxies /ws to
 * this port, so nothing else should reach it directly. Listening on every
 * interface takes an explicit HOST=0.0.0.0, never a default.
 */
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8080);

let DEV = false;
try {
  DEV = devModeFromEnv(process.env);
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

/**
 * Open a room.
 *
 * `kind` defaults to staked, which is the safe default: a caller that forgets
 * to say gets a room that refuses to seat bots rather than one that allows
 * them. `fillWithBots` only does anything in a free room.
 */
export function openRoom(
  matchId: string,
  roster: RosterEntry[],
  startWhenSeated = 0,
  onDone?: () => void,
  kind: RoomKind = "staked",
  fillWithBots = false,
): Room {
  const room = new Room(matchId, roster, (_log, hash) => {
    // Settlement goes here. The resolver signs (matchId, hash, standings) and
    // submits the payout instruction. Until the Anchor program exists, the log
    // is written to disk so replays can be tested against a real match.
    console.log(`[match ${matchId}] finished, log hash ${hash}`);
    onDone?.();
  }, startWhenSeated, kind, fillWithBots);
  rooms.set(matchId, room);
  if (startWhenSeated === 0) room.start();
  return room;
}

/**
 * Dev only. Reached solely through the DEV flag, which devModeFromEnv never
 * sets in production. When a round ends a fresh room replaces it, so tabs can
 * reload and play again without restarting the server.
 */
function openDevRoom(): void {
  // Free, and bots fill whatever seats are still empty when the round starts,
  // so one or two tabs is a full six player match to play against.
  openRoom(DEV_MATCH_ID, devRoster(), DEV_MIN_SEATED, () => {
    setTimeout(openDevRoom, 3000);
  }, "free", true);
  console.warn(`[dev] free room "${DEV_MATCH_ID}" open, starts when ${DEV_MIN_SEATED} players join, bots fill the rest`);
}

/* ------------------------------------------------------------- socket --- */

interface Pending {
  nonce: string;
  issuedAt: number;
  used: boolean;
}

const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws: WebSocket) => {
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

  const kick = (reason: string) => {
    try { ws.send(JSON.stringify({ t: "kick", reason })); } catch { /* closing */ }
    ws.close();
  };

  ws.send(JSON.stringify({ t: "challenge", v: PROTOCOL_VERSION, nonce: pending.nonce }));

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

    const target = rooms.get(msg.matchId);
    if (!target) return kick("no such match");

    // The roster is the allow list. A wallet that did not stake has no seat,
    // whatever it signs.
    const entry = target.roster.find((r) => r.wallet === msg.wallet);
    if (!entry) return kick("not a participant in this match");

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
    target.seat(seat);

    ws.send(JSON.stringify({
      t: "accepted",
      slot,
      tick: target.world.tick,
      startsInMs: 0,
      roster: target.roster,
    }));
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

wss.on("listening", () => console.log(`floorfight server listening on ${HOST}:${PORT}`));

if (DEV) {
  console.warn(devWarning());
  openDevRoom();
}
