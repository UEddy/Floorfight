/**
 * The page's side of the bridge to the Android app (apps/mobile/src/bridge.ts).
 *
 * The page asks for intents and never sends bytes: connect, sign the join
 * handshake for a match id and nonce, or an escrow action on a match id or a
 * stake tier index. The app builds every message and transaction itself and
 * shows amounts before the wallet opens. This file cannot ask for anything
 * else, because the app refuses anything else.
 *
 * Outside the app, in a plain browser, there is no bridge, and the holders
 * mode says so instead of pretending.
 */

import { PROTOCOL_VERSION } from "../../shared/protocol";

interface RNWebView {
  postMessage(data: string): void;
}

function rn(): RNWebView | null {
  const w = (window as unknown as { ReactNativeWebView?: RNWebView }).ReactNativeWebView;
  return w && typeof w.postMessage === "function" ? w : null;
}

/** True inside the Floorfight app. */
export function hasNative(): boolean {
  return rn() !== null;
}

type Reply = { id: string; ok: boolean; error?: string } & Record<string, unknown>;

const waiting = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
let counter = 0;

addEventListener("floorfight-native", (e) => {
  let reply: Reply;
  try {
    reply = JSON.parse(String((e as MessageEvent).data)) as Reply;
  } catch {
    return;
  }
  const w = waiting.get(reply.id);
  if (!w) return;
  waiting.delete(reply.id);
  if (reply.ok) w.resolve(reply);
  else w.reject(new Error(reply.error ?? "the app refused"));
});

/**
 * Wallet prompts wait on a person, so the timeout is long. It exists so a
 * request the app never answers does not leave a button spinning forever.
 */
const TIMEOUT_MS = 5 * 60_000;

function ask(body: Record<string, unknown>): Promise<Reply> {
  const bridge = rn();
  if (!bridge) return Promise.reject(new Error("holders play needs the Floorfight app"));
  const id = `r${++counter}`;
  return new Promise<Reply>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => {
      if (waiting.delete(id)) reject(new Error("the app did not answer"));
    }, TIMEOUT_MS);
    bridge.postMessage(JSON.stringify({ id, ...body }));
  });
}

export async function connect(): Promise<string> {
  const r = await ask({ t: "connect" });
  return String(r.wallet);
}

export async function signJoin(matchId: string, nonce: string): Promise<{ wallet: string; signature: string }> {
  const r = await ask({ t: "signJoin", v: PROTOCOL_VERSION, matchId, nonce });
  return { wallet: String(r.wallet), signature: String(r.signature) };
}

/**
 * Create a match at a tier, in a currency out of the fixed list. The app
 * maps both to an amount and, for "skr", its own devnet test mint. Resolves
 * to the match id the app generated ("skr-" in front for a token pot).
 */
export async function createMatch(
  tier: number, currency: "sol" | "skr" = "sol",
): Promise<{ matchId: string; signature: string }> {
  const r = await ask({ t: "escrow", action: "create", tier, currency });
  return { matchId: String(r.matchId), signature: String(r.signature) };
}

export async function escrow(
  action: "join" | "claim" | "refund", matchId: string,
): Promise<{ signature: string }> {
  const r = await ask({ t: "escrow", action, matchId });
  return { signature: String(r.signature) };
}
