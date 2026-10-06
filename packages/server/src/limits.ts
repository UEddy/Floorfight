/**
 * What one address, and the box as a whole, are allowed to ask for.
 *
 * None of this stops a determined attacker with a botnet. It stops the cheap
 * things: a script opening sockets in a loop, a browser tab left reconnecting
 * forever, one person filling every room so nobody else can play. The point
 * is that the failure mode of all of those becomes "that address is refused"
 * rather than "the droplet runs out of memory", on a box with 1 vCPU and
 * 512 MB.
 *
 * Everything here is a pure function of counts and strings, so it is tested
 * without opening a socket.
 */

/** Live sockets from one address. */
export const MAX_PER_IP = 8;

/** Live sockets in total. */
export const MAX_CONNECTIONS = 200;

/**
 * Rooms alive at once, free and staked together.
 *
 * Twenty is a safety ceiling, not a capacity claim. Twenty full rooms is 120
 * players simulated at 60 Hz, and each room's match log grows to roughly 8 MB
 * of objects by the end of a three minute round, so twenty of them is most of
 * the 256 MB heap the service runs with. The CPU or the heap will complain
 * before this cap does; it exists so that the thing which gives way is a
 * refused room rather than the kernel killing the process.
 */
export const MAX_ROOMS = 20;

/**
 * How many of those rooms free play may use.
 *
 * The rest are headroom for staked matches. A staked room has money in escrow
 * and people waiting for it, so it must never be the thing that cannot open
 * because free play filled the box.
 */
export const MAX_FREE_ROOMS = 16;

/** How long a socket has to finish the join handshake. */
export const JOIN_DEADLINE_MS = 10_000;

/**
 * Read a positive integer override out of the environment.
 *
 * The defaults above are the policy. These exist so a test does not have to
 * open two hundred sockets or wait ten seconds, and so that a limit can be
 * moved on the droplet without a deploy. Anything unparseable or zero or
 * negative is ignored rather than treated as "no limit".
 */
export function limitFromEnv(
  env: NodeJS.ProcessEnv, name: string, fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  // Plain digits only. Number() would happily read "1e3" as a thousand and
  // "0x10" as sixteen, and in a systemd Environment line either of those is
  // far more likely to be a typo than an intention.
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    console.warn(`[limits] ${name}=${raw} is not a positive integer, using ${fallback}`);
    return fallback;
  }
  return Number(raw);
}

/* ------------------------------------------------------------------ ip --- */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Loose on purpose: enough to tell an address from a word. */
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

/**
 * The two spellings of the IPv4 loopback that node hands back.
 *
 * `::1` is deliberately not in here. It is a different address, and the
 * deployment is Caddy on `127.0.0.1` proxying to a server bound to
 * `127.0.0.1`, so the IPv6 loopback never appears. Trusting more addresses
 * than the deployment needs is exactly how a forwarded-header rule goes
 * wrong.
 *
 * If the bind ever moves to `::1`, every connection will be bucketed under
 * that one untrusted address and the ninth player will be refused. That is a
 * loud failure, which is the right direction for this to fail in: the other
 * way round, the header would be believed from anywhere.
 */
const TRUSTED_PEERS = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

function plausibleIp(s: string): boolean {
  const m = IPV4.exec(s);
  if (m) return m.slice(1).every((part) => Number(part) <= 255);
  return IPV6.test(s);
}

/** Strip a port and brackets: "[::1]:5000" and "1.2.3.4:5000" both appear. */
function bareAddress(s: string): string {
  let v = s.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end > 0) return v.slice(1, end);
  }
  // Only strip a trailing :port from something with exactly one colon, so an
  // IPv6 address is left alone.
  const colons = v.split(":").length - 1;
  if (colons === 1) v = v.slice(0, v.indexOf(":"));
  return v;
}

/**
 * The address to hold responsible for a connection.
 *
 * Behind Caddy the TCP peer is always the loopback, so the real client is in
 * X-Forwarded-For. That header is trivially forged, so it is read only when
 * the peer is the loopback, and ignored completely otherwise: a direct
 * connection to the port cannot talk its way into somebody else's bucket.
 *
 * When the header is a list, the **last** entry is used. Caddy appends the
 * address it saw to whatever arrived, so the rightmost entry is the one Caddy
 * observed and everything to the left of it is whatever the client decided to
 * send. Reading the leftmost entry, which is the usual way this is written,
 * would let any client pick its own rate limit bucket by sending a header.
 */
export function clientIp(
  peer: string | undefined,
  forwarded: string | string[] | undefined,
): string {
  const peerAddr = peer ? bareAddress(peer) : "";
  if (!TRUSTED_PEERS.has(peerAddr)) {
    return peerAddr || "unknown";
  }

  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (typeof header === "string" && header.length > 0 && header.length < 1024) {
    const parts = header.split(",");
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = bareAddress(parts[i]);
      if (candidate && plausibleIp(candidate)) return candidate;
    }
  }
  // No usable header: this really is a connection from the box itself, which
  // is what a local dev client or a test looks like.
  return peerAddr;
}

/* --------------------------------------------------------- connections --- */

export type Verdict = "ok" | "too many from this address" | "server is full";

/**
 * Live connection counts, per address and in total.
 *
 * Admit and release have to be paired exactly once each, which is why release
 * takes the address back rather than keeping a handle: the caller already has
 * to remember it for logging, and a handle would be one more thing to forget
 * to use on the error path.
 */
export class ConnectionLimits {
  private perIp = new Map<string, number>();
  private live = 0;

  constructor(
    readonly maxPerIp = MAX_PER_IP,
    readonly maxTotal = MAX_CONNECTIONS,
  ) {}

  get total(): number {
    return this.live;
  }

  countFor(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  /** Addresses currently holding a connection. For the log line only. */
  get addresses(): number {
    return this.perIp.size;
  }

  /**
   * Take a slot for this address, or say why not.
   *
   * A refusal takes nothing, so a flood of refused connections cannot push
   * the counts up and lock out the people already playing.
   */
  admit(ip: string): Verdict {
    if (this.live >= this.maxTotal) return "server is full";
    const n = this.countFor(ip);
    if (n >= this.maxPerIp) return "too many from this address";
    this.perIp.set(ip, n + 1);
    this.live++;
    return "ok";
  }

  /** Give a slot back. Safe to call once per admitted connection, no more. */
  release(ip: string): void {
    const n = this.perIp.get(ip);
    if (n === undefined) return;
    if (n <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, n - 1);
    if (this.live > 0) this.live--;
  }
}

/**
 * Messages a socket may send: a token bucket, refilled continuously at
 * MAX_MSGS_PER_SECOND and holding up to MAX_MSG_BURST.
 *
 * It replaced a counter reset to 90 once a second, which is what kicked a
 * phone on mobile data mid match. A client sends 61 messages a second (an
 * input every tick and a pong), and 4G does not deliver them evenly: a cell
 * handover stalls the socket for a second or two, then everything queued in
 * that time arrives at once. Under the old counter a one second stall was
 * kicked about half the time and anything from a second and a half up
 * always was (see the stall test in limits.test.ts). The bucket lets that
 * backlog through and still caps the sustained rate at 90 a second, so the
 * worst a client can do with the burst allowance is send 300 small messages
 * once, which the per message size cap keeps to about a megabyte.
 */
export class MessageBudget {
  private tokens: number;
  private last: number;

  constructor(
    readonly rate: number,
    readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Spend one token. False means the socket is over its budget. */
  take(now: number): boolean {
    const dt = now - this.last;
    this.last = now;
    if (dt > 0) this.tokens = Math.min(this.burst, this.tokens + (dt / 1000) * this.rate);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
