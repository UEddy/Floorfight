/**
 * The boundary between the page and the wallet.
 *
 * The WebView is remote content. It is the real game, but this app has no way
 * to know that: whatever is served from the origin today could be something
 * else tomorrow, and a page that can ask the native side for a signature is
 * one XSS away from asking for the wrong one. So the rule here is the same one
 * the game server lives under, pointed the other way.
 *
 * The page sends intents. It never sends bytes.
 *
 * There are exactly three things it can ask for:
 *
 *   1. connect    authorise this app with the wallet and say which address
 *                 it is. Nothing is signed. The page needs the address to
 *                 show the person's NFTs and to know which results are theirs.
 *
 *   2. signJoin   sign the join handshake for a match. The page supplies a
 *                 match id and the nonce the server gave it. This side builds
 *                 the message string itself from a fixed template and refuses
 *                 to sign anything that does not match the pattern.
 *
 *   3. escrow     create a match at a stake tier, or join, claim or refund a
 *                 match id. For create the page sends a tier index and this
 *                 side looks the amount up in its own fixed list, generates
 *                 the match id itself, and builds create_match and join_match
 *                 into one transaction. For the others it reads the match
 *                 account from the chain. Either way it builds the
 *                 instructions from the program IDL, decides for itself
 *                 whether the action is possible, and shows the amount before
 *                 the wallet is opened.
 *
 * There is deliberately no request that carries a transaction, a message, a
 * byte array, an instruction, an account list, a program id or a lamport
 * amount. If the page could hand over any of those, every check in this file
 * would be decoration. Adding one is not an acceptable shortcut, for the same
 * reason the game protocol has no message that asserts a kill.
 */

import {
  MAX_PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  STAKE_TIERS,
} from "./config";

/* ------------------------------------------------------------ requests --- */

export type EscrowAction = "join" | "claim" | "refund";

export interface SignJoinRequest {
  id: string;
  t: "signJoin";
  v: number;
  matchId: string;
  nonce: string;
}

export interface EscrowRequest {
  id: string;
  t: "escrow";
  action: EscrowAction;
  matchId: string;
}

/** Create a match. A tier index into config.STAKE_TIERS, and nothing else. */
export interface CreateRequest {
  id: string;
  t: "escrow";
  action: "create";
  tier: number;
}

export interface ConnectRequest {
  id: string;
  t: "connect";
}

export type Request = ConnectRequest | SignJoinRequest | EscrowRequest | CreateRequest;

export type Reply =
  | { id: string; ok: true; t: "connect"; wallet: string }
  | { id: string; ok: true; t: "signJoin"; wallet: string; signature: string }
  | {
      id: string; ok: true; t: "escrow"; action: EscrowAction | "create";
      /** The match acted on. For create, the id this side generated. */
      matchId: string;
      signature: string;
    }
  | { id: string; ok: false; error: string };

/* ------------------------------------------------------------ patterns --- */

/**
 * The join message template.
 *
 * A deliberate copy of JOIN_MESSAGE_RE in packages/shared/protocol.ts, which
 * is where it is tested. It is copied rather than imported because this is the
 * check that stands between a hostile page and an ed25519 signature from the
 * person's wallet: it should not be able to change because something in
 * another package changed. If the game's join format ever changes, both have
 * to be edited by hand, on purpose.
 *
 * Nothing matching this can be a Solana transaction, which is the other thing
 * an off-chain signing path has to be sure of before it signs anything.
 */
const JOIN_MESSAGE_RE =
  /^floorfight:join:v(\d{1,3}):([A-Za-z0-9_-]{1,64}):([1-9A-HJ-NP-Za-km-z]{16,64})$/;

/** Correlation id, so a reply can be matched to its request. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Match id as it appears in a join message. The dev room uses "dev"; a real
 * match uses the on-chain u64 written out in decimal, which is what keeps the
 * string the server signs and the account the program settles in agreement.
 */
const MATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** On-chain match id: a u64, decimal, no sign and no padding games. */
const ESCROW_MATCH_ID_RE = /^(0|[1-9][0-9]{0,19})$/;

/** The server issues base58 of 24 random bytes. */
const NONCE_RE = /^[1-9A-HJ-NP-Za-km-z]{16,64}$/;

/** Nothing the page sends should be anywhere near this long. */
const MAX_MESSAGE_BYTES = 2048;

/* ---------------------------------------------------------- validation --- */

export class Refused extends Error {}

function refuse(why: string): never {
  throw new Refused(why);
}

function str(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== "string") refuse(`${what} must be a string`);
  if (!re.test(v)) refuse(`${what} is not in the accepted form`);
  return v;
}

/**
 * Parse one message from the page.
 *
 * Throws Refused on anything that is not exactly one of the requests above.
 * There is no lenient path and no coercion: a field of the wrong type, an
 * unknown request type, an extra key, or a string that does not match its
 * pattern all end here.
 */
export function parseRequest(raw: string): Request {
  if (typeof raw !== "string") refuse("message was not text");
  // Counted in UTF-16 code units, which over-counts rather than under-counts
  // for anything non-ASCII, so the real byte length is never larger.
  if (raw.length === 0 || raw.length > MAX_MESSAGE_BYTES) refuse("message length");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse("message was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("message was not an object");
  }
  const o = parsed as Record<string, unknown>;
  const id = str(o.id, ID_RE, "id");

  if (o.t === "signJoin") {
    // Exactly these keys, nothing else. An unexpected key means the page is
    // speaking a protocol this build does not have, and guessing which parts
    // of it to honour is how a bridge grows a hole.
    expectKeys(o, ["id", "t", "v", "matchId", "nonce"]);
    const v = o.v;
    if (typeof v !== "number" || !Number.isInteger(v)) refuse("v must be an integer");
    if (v < MIN_PROTOCOL_VERSION || v > MAX_PROTOCOL_VERSION) refuse("unsupported protocol version");
    return {
      id,
      t: "signJoin",
      v,
      matchId: str(o.matchId, MATCH_ID_RE, "matchId"),
      nonce: str(o.nonce, NONCE_RE, "nonce"),
    };
  }

  if (o.t === "connect") {
    expectKeys(o, ["id", "t"]);
    return { id, t: "connect" };
  }

  if (o.t === "escrow" && o.action === "create") {
    // A tier, as a small integer index. Not an amount: the amount lives in
    // config.ts, and an index that is not in the list is refused here.
    expectKeys(o, ["id", "t", "action", "tier"]);
    const tier = o.tier;
    if (typeof tier !== "number" || !Number.isInteger(tier)) refuse("tier must be an integer");
    if (tier < 0 || tier >= STAKE_TIERS.length) refuse("no such tier");
    return { id, t: "escrow", action: "create", tier };
  }

  if (o.t === "escrow") {
    expectKeys(o, ["id", "t", "action", "matchId"]);
    const action = o.action;
    if (action !== "join" && action !== "claim" && action !== "refund") {
      refuse("action must be join, claim or refund");
    }
    return {
      id,
      t: "escrow",
      action,
      matchId: str(o.matchId, ESCROW_MATCH_ID_RE, "matchId"),
    };
  }

  refuse("unknown request");
}

function expectKeys(o: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) refuse(`unexpected field ${k}`);
  }
}

/**
 * Build the join message this app is willing to sign, from parts it has
 * already validated, and check the result against the template.
 *
 * The page never supplies this string. It supplies a match id and a nonce,
 * and gets back a signature over whatever this function produces. The second
 * check is not redundant: it is what makes the template, rather than this
 * function's formatting, the thing that decides what can be signed.
 */
export function buildJoinMessage(req: SignJoinRequest): string {
  const message = `floorfight:join:v${req.v}:${req.matchId}:${req.nonce}`;
  const m = JOIN_MESSAGE_RE.exec(message);
  if (!m) refuse("built message does not match the join template");
  if (m[1] !== String(req.v) || m[2] !== req.matchId || m[3] !== req.nonce) {
    refuse("built message does not round trip");
  }
  return message;
}

/**
 * The reply, as a line of JavaScript to run in the page.
 *
 * Double encoded on purpose: the inner stringify makes the payload, and the
 * outer one turns it into a JavaScript string literal. Interpolating JSON
 * straight into injected source is an injection in the other direction, and
 * this app would be the one running it.
 *
 * JSON.stringify is not quite enough on its own. It leaves U+2028 and U+2029
 * as themselves, and those two are line terminators in JavaScript source, so
 * a reply carrying one could end the statement it was supposed to be a string
 * inside. ES2019 made them legal inside string literals and every current
 * Android WebView is fine with them, but "the engine on the phone is new
 * enough" is not a thing worth betting a wallet on, so they are escaped.
 */
export function replyScript(reply: Reply): string {
  const literal = JSON.stringify(JSON.stringify(reply))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function(){try{window.dispatchEvent(new MessageEvent("floorfight-native",{data:${literal}}));}catch(e){}})();true;`;
}

/**
 * Is this message really from the page we loaded?
 *
 * react-native-webview reports the URL of the frame that posted the message.
 * An iframe or a navigation to somewhere else therefore cannot pass for the
 * game: the URL has to sit under the origin this build was compiled with.
 */
export function fromGameOrigin(url: string | undefined, origin: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url === origin) return true;
  // Origin plus a separator, so "https://floorfight.duckdns.org.example.com"
  // does not pass for "https://floorfight.duckdns.org".
  return url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`) ||
    url.startsWith(`${origin}#`);
}
