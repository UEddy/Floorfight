/**
 * Local development room. Dev builds only.
 *
 * The dev roster is six keypairs derived from fixed, public labels, so the
 * server and every browser tab can derive the same keys without anything
 * secret being shipped or stored. These keys are worthless by construction:
 * anyone can derive them. That is fine because the dev room only exists when
 * the server was started with ARENA_DEV=1 outside production, and it holds no
 * stake. A production server never opens a room with this roster, so knowing
 * these keys gets nobody into a real match.
 *
 * The join path is the real one. Clients still answer the server's nonce with
 * a signature, so the dev room exercises the same handshake a staked match
 * will.
 */

export const DEV_MATCH_ID = "dev";
export const DEV_SEATS = 6;

/** Seats that must be connected before the dev round starts ticking. */
export const DEV_MIN_SEATED = 2;

/** Hash this with sha512 and keep the first 32 bytes as the ed25519 seed. */
export function devSeedLabel(seat: number): string {
  return `arena:dev-seat:${seat}`;
}
