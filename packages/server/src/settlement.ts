/**
 * What happens when a round ends.
 *
 * Two things, in this order:
 *
 *   1. The canonical match log is written to disk, byte for byte as it was
 *      hashed. Caddy serves that directory read only, so anyone who wants to
 *      check the result can download the log, rehash it and replay it.
 *   2. If the match was staked, the resolver submits the placements and that
 *      hash to the escrow program.
 *
 * The log is written first on purpose. A settlement that names a log hash
 * nobody can fetch is worse than useless: it looks like evidence and cannot
 * be checked. If the write fails, the settlement does not go out, the match
 * refunds on its deadline, and everybody gets their stake back.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalise, type MatchLog } from "../../shared/protocol";
import { placementsFrom } from "./chain";

/** Where logs go. Caddy serves this directory at /logs/. */
export const DEFAULT_LOG_DIR = "/var/lib/floorfight/logs";

/** Match ids that may become a file name. Nothing with a slash or a dot. */
const SAFE_MATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Write the canonical log.
 *
 * Written to a temporary name and renamed, which is atomic within a
 * directory: a reader either sees the whole log or no file at all, never a
 * half written one that would hash to nothing recognisable.
 */
export function writeMatchLog(dir: string, log: MatchLog): string {
  if (!SAFE_MATCH_ID.test(log.matchId)) {
    throw new Error(`match id ${JSON.stringify(log.matchId)} is not safe as a file name`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${log.matchId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, canonicalise(log), { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
  return path;
}

export interface FinishOptions {
  logDir: string;
  /** Staked matches only: the on-chain id and the player count. */
  staked: { matchId: bigint; count: number } | null;
  /**
   * How to settle, supplied by whoever has the chain configuration.
   *
   * Passed in rather than imported so that this module needs no network and
   * no key to be tested, and so that a server with no resolver cannot settle
   * by accident: there is simply nothing here to call.
   */
  settle?: (matchId: bigint, placements: number[], logHash: Buffer) => Promise<unknown>;
}

/**
 * Finish a match: write the log, then settle if there is anything to settle.
 *
 * `hash` is the sha256 of the canonical log, which the room has already
 * computed. It is taken as an argument rather than recomputed so that the
 * value written on chain is provably the same one the room reported to the
 * players in its `over` message.
 */
export async function finishMatch(
  log: MatchLog, hash: string, opts: FinishOptions,
): Promise<void> {
  const path = writeMatchLog(opts.logDir, log);
  console.log(`[match ${log.matchId}] log written to ${path}`);

  if (!opts.staked) return;
  if (!opts.settle) {
    throw new Error(
      `match ${log.matchId} was staked but this server has no chain configuration, ` +
      "so it cannot be settled. It will refund on its deadline.",
    );
  }

  const placements = placementsFrom(log.standings, opts.staked.count);
  const logHash = Buffer.from(hash, "hex");
  if (logHash.length !== 32) throw new Error(`log hash ${hash} is not 32 bytes`);
  console.log(
    `[match ${log.matchId}] settling places ${placements.join(",")} with ${hash}`,
  );
  await opts.settle(opts.staked.matchId, placements, logHash);
}
