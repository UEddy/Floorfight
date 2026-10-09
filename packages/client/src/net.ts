import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  PROTOCOL_VERSION,
  joinMessage,
  type ClientMsg,
  type LobbyView,
  type ServerMsg,
} from "../../shared/protocol";

export interface NetHandlers {
  onAccepted(msg: Extract<ServerMsg, { t: "accepted" }>): void;
  onSnap(msg: Extract<ServerMsg, { t: "snap" }>): void;
  onOver(msg: Extract<ServerMsg, { t: "over" }>): void;
  onKick(reason: string): void;
  onClose(): void;
  /** Holders only: how the lobby stands, until the room opens. */
  onLobby?(view: LobbyView): void;
}

/** A signed join, ready to send. */
export interface SignedJoin {
  matchId: string;
  /** Base58 public key. */
  wallet: string;
  /** Base58 ed25519 signature over joinMessage(matchId, nonce). */
  sig: string;
  /** Holders: the NFT asked for. The server checks who owns it. */
  mint?: string;
}

/**
 * Which match to join, and the signature for it, decided when the challenge
 * lands. Async, because a holder's signature comes from their wallet through
 * the app. Returning null means there is nothing to join.
 */
export type ResolveJoin = (challenge: {
  freeMatchId: string | null;
  /** The SKR lounge room on offer, if the server has one. */
  loungeMatchId: string | null;
  nonce: string;
}) => Promise<SignedJoin | null>;

/** Sign a join with a key held in this page: a guest, or a dev seat. */
export function signLocally(matchId: string, nonce: string, keys: nacl.SignKeyPair): SignedJoin {
  // The match id is inside the signed message, so this signature is good
  // for this match and no other.
  const text = new TextEncoder().encode(joinMessage(matchId, nonce));
  return {
    matchId,
    wallet: bs58.encode(keys.publicKey),
    sig: bs58.encode(nacl.sign.detached(text, keys.secretKey)),
  };
}

/**
 * Socket plus join handshake. The client never picks its slot or asserts
 * anything about itself beyond the wallet: it signs the server's nonce, and the
 * server decides whether that wallet has a seat.
 */
export class Net {
  private ws: WebSocket;
  private closedByUs = false;

  constructor(
    url: string,
    resolve: ResolveJoin,
    handlers: NetHandlers,
  ) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.t) {
        case "challenge": {
          if (msg.v !== PROTOCOL_VERSION) {
            handlers.onKick(`protocol mismatch: server v${msg.v}, client v${PROTOCOL_VERSION}`);
            this.close();
            return;
          }
          void resolve({ freeMatchId: msg.freeMatchId, loungeMatchId: msg.loungeMatchId ?? null, nonce: msg.nonce }).then((choice) => {
            if (!choice) {
              handlers.onKick("no room available right now");
              this.close();
              return;
            }
            this.send({
              t: "join",
              v: PROTOCOL_VERSION,
              matchId: choice.matchId,
              wallet: choice.wallet,
              sig: choice.sig,
              ...(choice.mint ? { mint: choice.mint } : {}),
            });
          }, (e: unknown) => {
            handlers.onKick((e as Error).message);
            this.close();
          });
          return;
        }
        case "lobby": return handlers.onLobby?.(msg);
        case "accepted": return handlers.onAccepted(msg);
        case "snap": return handlers.onSnap(msg);
        case "over": return handlers.onOver(msg);
        case "ping": return this.send({ t: "pong", id: msg.id });
        case "kick": return handlers.onKick(msg.reason);
      }
    };
    this.ws.onclose = () => {
      if (!this.closedByUs) handlers.onClose();
    };
  }

  /** Bytes the browser is still holding for this socket, not yet sent. */
  get buffered(): number {
    return this.ws.bufferedAmount;
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}
