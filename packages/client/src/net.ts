import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  PROTOCOL_VERSION,
  joinMessage,
  type ClientMsg,
  type ServerMsg,
} from "../../shared/protocol";

export interface NetHandlers {
  onAccepted(msg: Extract<ServerMsg, { t: "accepted" }>): void;
  onSnap(msg: Extract<ServerMsg, { t: "snap" }>): void;
  onOver(msg: Extract<ServerMsg, { t: "over" }>): void;
  onKick(reason: string): void;
  onClose(): void;
}

/**
 * Which match to join, and with which key, decided when the challenge lands.
 *
 * The challenge carries the free room this connection would be seated in, so
 * a guest cannot know which match it is joining until then. Returning null
 * means there is nothing to join.
 */
export type ResolveJoin = (challenge: {
  freeMatchId: string | null;
}) => { matchId: string; keys: nacl.SignKeyPair } | null;

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
          const choice = resolve({ freeMatchId: msg.freeMatchId });
          if (!choice) {
            handlers.onKick("no room available right now");
            this.close();
            return;
          }
          // The match id is inside the signed message, so this signature is
          // good for this match and no other.
          const text = new TextEncoder().encode(joinMessage(choice.matchId, msg.nonce));
          const sig = nacl.sign.detached(text, choice.keys.secretKey);
          this.send({
            t: "join",
            v: PROTOCOL_VERSION,
            matchId: choice.matchId,
            wallet: bs58.encode(choice.keys.publicKey),
            sig: bs58.encode(sig),
          });
          return;
        }
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

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}
