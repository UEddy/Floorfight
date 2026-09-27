import type { HitEvent } from "../../shared/sim";
import type { RosterEntry, SnapshotPlayer, Standing } from "../../shared/protocol";
import { SLOT_COLORS } from "./render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 4)}...${w.slice(-4)}` : w;
}

/**
 * Everything drawn here comes from server messages: scores and deaths from
 * snapshots, hits and kills from the server's hit events. The client never
 * scores anything itself.
 */
export class Hud {
  private hit = $("hitmarker");
  private hitTimer = 0;
  private feed = $("feed");
  private board = $("board");
  private timer = $("timer");
  private hp = $("hp");
  private net = $("net");
  private center = $("center");
  private over = $("over");
  private stick = $("stick");
  private boardKey = "";
  names: string[] = [];

  constructor(private localSlot: number) {}

  setRoster(roster: RosterEntry[]): void {
    this.names = roster.map((r) => `P${r.slot + 1} ${shortWallet(r.wallet)}`);
  }

  message(text: string): void {
    this.center.textContent = text;
  }

  hitMarker(e: HitEvent): void {
    this.hit.className = `hud show${e.head ? " head" : ""}${e.lethal ? " kill" : ""}`;
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => {
      this.hit.className = "hud";
    }, e.lethal ? 260 : 120);
  }

  kill(e: HitEvent): void {
    const row = document.createElement("div");
    const who = (s: number) => (s === this.localSlot ? "you" : `P${s + 1}`);
    const tag = (s: number) =>
      `<span style="color:${hex(SLOT_COLORS[s % SLOT_COLORS.length])}">${who(s)}</span>`;
    row.innerHTML = `${tag(e.shooter)} ${e.head ? "headshot" : "killed"} ${tag(e.victim)}`;
    if (e.shooter === this.localSlot || e.victim === this.localSlot) row.className = "me";
    this.feed.prepend(row);
    while (this.feed.children.length > 6) this.feed.lastElementChild?.remove();
  }

  scoreboard(players: SnapshotPlayer[], seated: Set<number>): void {
    const rows = [...players].sort((a, b) => b.k - a.k || a.d - b.d || a.s - b.s);
    const key = rows.map((p) => `${p.s}:${p.k}:${p.d}:${seated.has(p.s) ? 1 : 0}`).join(",");
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.innerHTML =
      `<div class="row head"><span class="name">player</span><span>K</span><span>D</span></div>` +
      rows
        .map((p) => {
          const cls = p.s === this.localSlot ? "me" : seated.has(p.s) ? "" : "empty";
          const sw = `<span class="sw" style="background:${hex(SLOT_COLORS[p.s % SLOT_COLORS.length])}"></span>`;
          const name = p.s === this.localSlot ? `P${p.s + 1} (you)` : `P${p.s + 1}`;
          return `<div class="row ${cls}"><span class="name">${sw}${name}</span><span>${p.k}</span><span>${p.d}</span></div>`;
        })
        .join("");
  }

  clock(secondsLeft: number | null): void {
    if (secondsLeft === null) {
      this.timer.textContent = "1:30";
      this.timer.classList.remove("low");
      return;
    }
    const s = Math.max(0, Math.ceil(secondsLeft));
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.timer.classList.toggle("low", s <= 10);
  }

  health(hp: number, alive: boolean): void {
    this.hp.textContent = alive ? String(hp) : "dead";
  }

  netStats(text: string): void {
    this.net.textContent = text;
  }

  stickAt(s: { ox: number; oy: number } | null): void {
    if (!s) {
      this.stick.style.display = "none";
      return;
    }
    this.stick.style.display = "block";
    this.stick.style.left = `${s.ox}px`;
    this.stick.style.top = `${s.oy}px`;
  }

  showOver(standings: Standing[], logHash: string, onAgain: () => void): void {
    const body = this.over.querySelector("tbody")!;
    body.innerHTML = standings
      .map((s) => {
        const me = s.slot === this.localSlot ? ` class="me"` : "";
        const name = `P${s.slot + 1} ${shortWallet(s.wallet)}${s.slot === this.localSlot ? " (you)" : ""}`;
        return `<tr${me}><td>${s.place}</td><td>${name}</td><td>${s.kills}</td><td>${s.deaths}</td></tr>`;
      })
      .join("");
    this.over.querySelector(".hash b")!.textContent = logHash;
    this.over.querySelector("button")!.onclick = onAgain;
    this.over.classList.add("show");
  }
}
