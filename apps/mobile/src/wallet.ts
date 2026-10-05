/**
 * Mobile Wallet Adapter, kept behind two functions.
 *
 * Nothing else in the app talks to a wallet. Both functions open a session,
 * do one thing and close it, which means there is no long lived authorisation
 * sitting around and no handle the rest of the app could use to sign
 * something unexpected.
 *
 * MWA is why this app cannot run in Expo Go: it is native Android code that
 * has to be in the binary. See the README.
 */

import { transact, type Web3MobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { APP_IDENTITY, CHAIN } from "./config";

/**
 * Cached authorisation token.
 *
 * Only the token, which lets a second session reconnect without the person
 * approving the app again. No key material and nothing that can sign: every
 * signature still goes through the wallet app and still needs whatever
 * confirmation the wallet asks for.
 */
let authToken: string | undefined;
let lastAddress: string | undefined;

interface Authorized {
  /** Base64, as MWA hands it over. This is what signMessages wants. */
  address: string;
  publicKey: PublicKey;
}

async function authorize(wallet: Web3MobileWallet): Promise<Authorized> {
  const result = authToken
    ? await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY })
    : await wallet.authorize({ chain: CHAIN, identity: APP_IDENTITY });
  authToken = result.auth_token;
  const account = result.accounts[0];
  if (!account) throw new Error("the wallet authorised no accounts");
  lastAddress = account.address;
  // MWA returns the address base64 encoded; web3.js wants bytes.
  const bytes = Uint8Array.from(Buffer.from(account.address, "base64"));
  return { address: account.address, publicKey: new PublicKey(bytes) };
}

/** The wallet this app last used, as a base58 address, or null. */
export function currentWallet(): string | null {
  if (!lastAddress) return null;
  return new PublicKey(Uint8Array.from(Buffer.from(lastAddress, "base64"))).toBase58();
}

/** Forget the authorisation. The next request asks the person again. */
export function forgetWallet(): void {
  authToken = undefined;
  lastAddress = undefined;
}

/**
 * Sign one message.
 *
 * `message` comes from buildJoinMessage and nowhere else, so by the time it
 * gets here it is known to be a join handshake for a match. This function
 * does not inspect it again: the check belongs where the string is made, and
 * splitting it over two files would mean neither is obviously the one that
 * matters.
 */
export async function signMessage(message: string): Promise<{ wallet: string; signature: string }> {
  return transact(async (wallet) => {
    const { address, publicKey } = await authorize(wallet);
    const payload = new Uint8Array(Buffer.from(message, "utf8"));
    const signed = await wallet.signMessages({
      addresses: [address],
      payloads: [payload],
    });
    const returned = signed[0];
    if (!returned) throw new Error("the wallet returned no signature");

    /*
     * Pull out the 64 signature bytes.
     *
     * The MWA spec has signMessages return the payload with the signature
     * appended, so the signature is the last 64 bytes. Some wallets return
     * only the signature. Both are handled; anything else is refused rather
     * than guessed at, because the game server will reject a wrong length
     * signature as a bad credential and the person would have no idea why.
     */
    const bytes = Uint8Array.from(returned);
    let signature: Uint8Array;
    if (bytes.length === 64) {
      signature = bytes;
    } else if (bytes.length === payload.length + 64) {
      signature = bytes.slice(payload.length);
    } else {
      throw new Error(`the wallet returned ${bytes.length} bytes, which is not a signature`);
    }

    // Base58, which is what the game server's join handler decodes.
    return { wallet: publicKey.toBase58(), signature: bs58.encode(signature) };
  });
}

/** Sign and send one transaction built by escrow.ts. */
export async function signAndSend(
  build: (player: PublicKey) => Promise<Transaction>,
): Promise<string> {
  return transact(async (wallet) => {
    const { publicKey } = await authorize(wallet);
    const tx = await build(publicKey);
    const signatures = await wallet.signAndSendTransactions({ transactions: [tx] });
    const sig = signatures[0];
    if (!sig) throw new Error("the wallet sent nothing");
    return sig;
  });
}
