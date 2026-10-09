/**
 * The screens before and after a round: choosing a mode, the holders flow,
 * the lobby, and a holders match's results.
 *
 * Free is the game as it has always been: a guest key made up on this page
 * load, a free room, bots after a few seconds.
 *
 * Holders needs the Floorfight app, because the money moves through the
 * wallet the app holds. The page asks the app for intents only (see
 * native.ts): connect, create at a tier index, join a match id, sign a join,
 * claim or refund. Every amount a person approves is shown by the app from
 * its own tier list or from the chain, never from here. What this page shows
 * is for orientation, and says where its numbers come from.
 */

import { SKR_POT_LABEL, tiersFor, type Currency } from "../../shared/tiers";
import type { LobbyView } from "../../shared/protocol";
import * as native from "./native";
import { LOUNGE_MIN_TIER, SKR_STAKE_URL, SKR_TIERS, cleanTier, tierName } from "../../shared/skr";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** An amount in its smallest unit, at some decimals, trimmed. Display only. */
export function units(raw: string | bigint, decimals: number): string {
  const n = BigInt(raw);
  if (decimals === 0) return n.toString();
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}

/** What a currency is called on screen. A token pot is never just "SKR". */
function unitName(currency: Currency): string {
  return currency === "sol" ? "SOL" : SKR_POT_LABEL;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function short(w: string): string {
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export interface Nft { id: string; name: string; collection: string | null; image: string | null }

export interface MenuHandlers {
  /** Free play, as before. */
  free(): void;
  /** Enter a holders match: the caller connects and signs the join. */
  holders(matchId: string, wallet: string, mint: string | null): void;
  /** Enter the SKR lounge with this wallet: the caller signs the join. */
  lounge(wallet: string, mint: string | null): void;
}

/** What /api/skr says about a wallet. The server read it; this only shows it. */
interface SkrView { balance: string; tier: number; decimals: number | null }

interface OpenMatch { matchId: string; stake: string; count: number; maxPlayers: number; joinDeadline: number }

export class Menu {
  private el = $("menu");
  private wallet: string | null = null;
  private mint: string | null = null;
  private tier = 0;
  private currency: Currency = "sol";
  /**
   * Decimals per currency, as the server last reported them (it reads the
   * mint). Display only: the app reads them again for itself before anything
   * is signed.
   */
  private decimals: Record<Currency, number | null> = { sol: 9, skr: null };
  /** Whether this server hosts Test SKR pots; null until it has said. */
  private skrPots: boolean | null = null;

  constructor(private h: MenuHandlers) {}

  hide(): void {
    this.el.classList.remove("show");
  }

  /** The first screen: Free or Holders. */
  showModes(): void {
    const inApp = native.hasNative();
    this.el.innerHTML = `
      <div class="card modes">
        <h1>Floorfight</h1>
        <p class="sub">Six players, three minutes, one hall.</p>
        <button class="mode" data-m="free">
          <b>Free</b><span>Play now as a guest. No wallet, nothing staked.</span>
        </button>
        <button class="mode" data-m="holders" ${inApp ? "" : "disabled"}>
          <b>Holders</b><span>${inApp
            ? "Stake devnet SOL with your wallet. Top three split the pot."
            : "Needs the Floorfight Android app, which holds your wallet."}</span>
        </button>
      </div>`;
    this.el.classList.add("show");
    (this.el.querySelector('[data-m="free"]') as HTMLButtonElement).onclick = () => {
      this.hide();
      this.h.free();
    };
    (this.el.querySelector('[data-m="holders"]') as HTMLButtonElement).onclick = () => {
      void this.showHolders();
    };
  }

  /** Holders: wallet, head, currency, tier, open matches. */
  async showHolders(): Promise<void> {
    if (this.skrPots === null) {
      // Only offer Test SKR pots when the server says it hosts them (it
      // answers 503 when it has no SKR_POT_MINT). Asked once per page load.
      try {
        const r = await fetch(`/api/matches?tier=0&currency=skr`, { headers: { Accept: "application/json" } });
        this.skrPots = r.status !== 503 && r.status !== 404;
      } catch {
        this.skrPots = false;
      }
    }
    if (!this.skrPots) this.currency = "sol";
    const tiers = tiersFor(this.currency);
    if (this.tier >= tiers.length) this.tier = 0;
    const currencies: Currency[] = this.skrPots ? ["sol", "skr"] : ["sol"];
    this.el.innerHTML = `
      <div class="card holders">
        <div class="row head"><h1>Holders</h1><button class="link" data-a="back">Back</button></div>
        <div class="wallet"></div>
        <div class="skr"></div>
        <div class="nfts"></div>
        ${currencies.length > 1 ? `<div class="tiers cur">${currencies.map((c) =>
          `<button data-cur="${c}" class="${c === this.currency ? "on" : ""}">${esc(unitName(c))}</button>`).join("")}</div>` : ""}
        <div class="tiers">${tiers.map((t, i) =>
          `<button data-tier="${i}" class="${i === this.tier ? "on" : ""}">${esc(t.label)}</button>`).join("")}</div>
        <div class="list"><p class="dim">Loading open matches...</p></div>
        <button class="primary" data-a="create">Create a match at ${esc(tiers[this.tier].label)}</button>
        <p class="note">Devnet. ${this.currency === "skr"
          ? "Test SKR is a devnet test token with no value, not the real SKR. "
          : ""}Amounts are confirmed by the app before your wallet opens.</p>
        <p class="err"></p>
      </div>`;
    this.el.classList.add("show");
    (this.el.querySelector('[data-a="back"]') as HTMLButtonElement).onclick = () => this.showModes();
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-cur]")) {
      b.onclick = () => {
        this.currency = b.dataset.cur === "skr" ? "skr" : "sol";
        this.tier = 0;
        void this.showHolders();
      };
    }
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-tier]")) {
      b.onclick = () => {
        this.tier = Number(b.dataset.tier);
        void this.showHolders();
      };
    }
    (this.el.querySelector('[data-a="create"]') as HTMLButtonElement).onclick = () => void this.create();
    this.renderWallet();
    void this.loadMatches();
  }

  private err(e: unknown): void {
    const p = this.el.querySelector(".err");
    if (p) p.textContent = e ? (e as Error).message : "";
  }

  private renderWallet(): void {
    const box = this.el.querySelector(".wallet");
    if (!box) return;
    if (!this.wallet) {
      box.innerHTML = `<button class="primary" data-a="connect">Connect wallet</button>`;
      (box.querySelector("button") as HTMLButtonElement).onclick = async () => {
        this.err(null);
        try {
          this.wallet = await native.connect();
          this.renderWallet();
        } catch (e) {
          this.err(e);
        }
      };
      return;
    }
    box.innerHTML = `<p>Wallet <b>${esc(short(this.wallet))}</b></p>`;
    void this.loadNfts();
    void this.loadSkr();
  }

  /**
   * The SKR panel: the wallet's SKR balance on mainnet as the server read
   * it, the badge it earns, and the lounge if it earns enough. Read only:
   * nothing here can move SKR, and the copy says so.
   */
  private async loadSkr(): Promise<void> {
    const box = this.el.querySelector(".skr");
    if (!box || !this.wallet) return;
    const wallet = this.wallet;
    box.innerHTML = `<div class="skrbox"><b>SKR</b> <span class="dim">Reading your mainnet balance...</span></div>`;
    let v: SkrView;
    try {
      v = await getJson<SkrView>(`/api/skr/${wallet}`);
    } catch {
      box.innerHTML = `<div class="skrbox"><b>SKR</b> <span class="dim">Could not read your SKR balance right now. No badge this time.</span></div>`;
      return;
    }
    const tier = cleanTier(v.tier);
    const name = tierName(tier);
    const next = SKR_TIERS[tier];
    const lounge = tier >= LOUNGE_MIN_TIER;
    box.innerHTML = `
      <div class="skrbox">
        <div class="row"><b>SKR</b><span>${esc(v.balance)} SKR${name
          ? ` <span class="badge" style="--c:#${SKR_TIERS[tier - 1].colour.toString(16).padStart(6, "0")}">${esc(name)}</span>`
          : ""}</span></div>
        <p class="dim">${name
          ? `Your ${esc(name)} badge shows on your nameplate, in the kill feed and as a halo over your character. Cosmetic only: it never changes how the game plays.`
          : `Hold ${SKR_TIERS[0].min} SKR or more on mainnet for a badge on your nameplate and character, and the SKR lounge.`}
          ${next ? ` ${esc(next.name)} at ${next.min.toLocaleString("en")} SKR.` : ""}</p>
        ${lounge ? `<button data-a="lounge">Play the SKR lounge</button>` : ""}
        <p class="note">Reads your mainnet SKR balance. It never moves your funds. Staked SKR is not counted yet.
          <a href="${SKR_STAKE_URL}" target="_blank" rel="noopener noreferrer">Stake SKR</a></p>
      </div>`;
    const b = box.querySelector<HTMLButtonElement>('[data-a="lounge"]');
    if (b) b.onclick = () => this.h.lounge(wallet, this.mint);
  }

  /**
   * The head picker. The list is the server's, from the chain's indexer, and
   * picking one is a request: the server checks ownership again at join and
   * anything it cannot confirm plays with the default face.
   */
  private async loadNfts(): Promise<void> {
    const box = this.el.querySelector(".nfts");
    if (!box || !this.wallet) return;
    box.innerHTML = `<p class="dim">Looking for your NFTs...</p>`;
    try {
      const { items } = await getJson<{ items: Nft[] }>(`/api/nfts/${this.wallet}`);
      if (items.length === 0) {
        box.innerHTML = `<p class="dim">No NFTs found. You will play with the default face.</p>`;
        return;
      }
      box.innerHTML = `<p class="dim">Pick a head</p><div class="grid">${items.slice(0, 24).map((n) => `
        <button data-mint="${esc(n.id)}" class="${n.id === this.mint ? "on" : ""}" title="${esc(n.name)}">
          ${n.image ? `<img src="/api/nft-img/${esc(n.id)}" alt="" loading="lazy">` : ""}
          <span>${esc(n.name)}</span>
        </button>`).join("")}</div>`;
      for (const b of box.querySelectorAll<HTMLButtonElement>("[data-mint]")) {
        b.onclick = () => {
          this.mint = this.mint === b.dataset.mint ? null : b.dataset.mint ?? null;
          for (const o of box.querySelectorAll("[data-mint]")) {
            o.classList.toggle("on", (o as HTMLElement).dataset.mint === this.mint);
          }
        };
      }
    } catch (e) {
      box.innerHTML = `<p class="dim">NFT heads unavailable (${esc((e as Error).message)}). Default face.</p>`;
    }
  }

  private async loadMatches(): Promise<void> {
    const box = this.el.querySelector(".list");
    if (!box) return;
    try {
      const { matches, decimals } = await getJson<{ matches: OpenMatch[]; decimals: number | null }>(
        `/api/matches?tier=${this.tier}&currency=${this.currency}`);
      if (typeof decimals === "number") this.decimals[this.currency] = decimals;
      if (matches.length === 0) {
        box.innerHTML = `<p class="dim">No open matches at ${esc(tiersFor(this.currency)[this.tier].label)}. Create one.</p>`;
        return;
      }
      const now = Date.now() / 1000;
      box.innerHTML = matches.map((m) => `
        <div class="match">
          <span>${m.count} of ${m.maxPlayers} in, ${Math.max(0, Math.floor((m.joinDeadline - now) / 60))} min left</span>
          <button data-join="${esc(m.matchId)}">Join</button>
        </div>`).join("");
      for (const b of box.querySelectorAll<HTMLButtonElement>("[data-join]")) {
        b.onclick = () => void this.join(b.dataset.join!);
      }
    } catch (e) {
      box.innerHTML = `<p class="dim">Could not list matches: ${esc((e as Error).message)}</p>`;
    }
  }

  private async ensureWallet(): Promise<string> {
    if (!this.wallet) {
      this.wallet = await native.connect();
      this.renderWallet();
    }
    return this.wallet;
  }

  private async create(): Promise<void> {
    this.err(null);
    try {
      const wallet = await this.ensureWallet();
      const { matchId } = await native.createMatch(this.tier, this.currency);
      this.h.holders(matchId, wallet, this.mint);
    } catch (e) {
      this.err(e);
    }
  }

  private async join(matchId: string): Promise<void> {
    this.err(null);
    try {
      const wallet = await this.ensureWallet();
      await native.escrow("join", matchId);
      this.h.holders(matchId, wallet, this.mint);
    } catch (e) {
      this.err(e);
    }
  }

  /* ------------------------------------------------------------ lobby --- */

  showLobby(v: LobbyView): void {
    const here = v.present.filter(Boolean).length;
    const left = Math.max(0, v.joinDeadline - Math.floor(Date.now() / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const status = v.phase === "locking"
      ? "Locking the match and opening the hall..."
      : v.phase === "expired"
        ? "The join window closed with fewer than two players. Your stake can be refunded."
        : v.count < 2
          ? "Waiting for a second player to join."
          : `Starts when everyone here is connected, or with ${v.lockBefore} seconds of the window left.`;
    this.el.innerHTML = `
      <div class="card lobby">
        <h1>Lobby</h1>
        <p class="sub">Match ${esc(v.matchId)} at ${esc(this.amount(v.stake, v.currency ?? "sol"))} each</p>
        <div class="seats">${Array.from({ length: v.maxPlayers }, (_, i) => {
          const cls = i >= v.count ? "empty" : v.present[i] ? "here" : "away";
          const label = i >= v.count ? "open" : v.present[i] ? "here" : "staked, not here";
          return `<div class="${cls}"><b>${i + 1}</b><span>${label}</span></div>`;
        }).join("")}</div>
        <p>${v.count} staked, ${here} here. Window closes in ${mmss}.</p>
        <p class="dim">${esc(status)}</p>
        <p class="note">No bots in a holders match. Anyone who is not here when it starts stands still.</p>
      </div>`;
    this.el.classList.add("show");
  }

  /** A stake with its unit, or just the unit when the decimals are not known yet. */
  private amount(raw: string, currency: Currency): string {
    const d = this.decimals[currency];
    return d === null ? `a ${unitName(currency)} stake` : `${units(raw, d)} ${unitName(currency)}`;
  }

  /* ---------------------------------------------------------- results --- */

  /**
   * The holders half of the end of round card. Polls the match account
   * through /api/match until it settles (or its settle window lapses), then
   * offers Claim or Refund through the app.
   */
  showResults(matchId: string, wallet: string): void {
    const box = $("holders-result");
    box.innerHTML = `<p class="dim">Waiting for the result on chain...</p>`;
    box.style.display = "block";
    let done = false;
    const poll = async () => {
      if (done) return;
      try {
        const m = await getJson<{
          state: string; players: string[]; placements: number[]; payouts: string[];
          claimed: number; settleDeadline: number; count: number; stake: string;
          currency?: Currency; decimals?: number; label?: string;
        }>(`/api/match/${matchId}`);
        // The currency is the chain's, via the server: the match account
        // says which escrow it is and the mint says the decimals.
        const d = m.decimals ?? 9;
        const unit = m.currency === "skr" ? SKR_POT_LABEL : "SOL";
        const slot = m.players.indexOf(wallet);
        const place = m.placements.indexOf(slot);
        const claimed = slot >= 0 && (m.claimed & (1 << slot)) !== 0;
        const now = Date.now() / 1000;
        const refundable = m.state === "Refunding" || (m.state === "Locked" && now > m.settleDeadline);
        const log = `<a href="/logs/${encodeURIComponent(matchId)}.json" target="_blank" rel="noopener">Match log</a>`;
        let line: string;
        let action: "claim" | "refund" | null = null;
        if (m.state === "Settled") {
          if (place >= 0) {
            line = `Place ${place + 1}. Payout <b>${esc(units(m.payouts[place], d))} ${esc(unit)}</b>${claimed ? ", claimed." : "."}`;
            if (!claimed) action = "claim";
          } else {
            line = "Settled. You did not place this time.";
          }
          done = true;
        } else if (refundable) {
          line = `Not settled in time. Refund <b>${esc(units(m.stake, d))} ${esc(unit)}</b>${claimed ? ", claimed." : "."}`;
          if (!claimed) action = "refund";
          done = true;
        } else {
          line = "Waiting for the resolver to settle on chain...";
        }
        box.innerHTML = `<p>${line}</p>${action
          ? `<button class="primary" data-a="${action}">${action === "claim" ? "Claim" : "Refund"}</button>`
          : ""}<p class="dim">${log}. Anyone can replay it with npm run replay.</p><p class="err"></p>`;
        const b = box.querySelector<HTMLButtonElement>("[data-a]");
        if (b && action) {
          const which = action;
          b.onclick = async () => {
            b.disabled = true;
            try {
              const { signature } = await native.escrow(which, matchId);
              box.querySelector(".err")!.textContent = "";
              b.outerHTML = `<p>Done. Transaction ${esc(short(signature))}</p>`;
            } catch (e) {
              b.disabled = false;
              box.querySelector(".err")!.textContent = (e as Error).message;
            }
          };
        }
      } catch (e) {
        box.innerHTML = `<p class="dim">Could not read the match: ${esc((e as Error).message)}</p>`;
      }
      if (!done) setTimeout(() => void poll(), 4000);
    };
    void poll();
  }
}
