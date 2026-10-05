/**
 * sha256, in plain TypeScript.
 *
 * There is a perfectly good sha256 in node:crypto and another in the browser's
 * WebCrypto, and neither is usable here. The node one does not exist in a
 * WebView, and the WebCrypto one is asynchronous, so it cannot be used to
 * derive a constant at module load. The map id is exactly that: a value both
 * the server and the client must compute identically, synchronously, before
 * anything else runs.
 *
 * Only integer operations: Math.imul, shifts, xor and additions truncated to
 * 32 bits. That makes it exact on any engine, which is the same requirement
 * the rest of shared/ lives under.
 *
 * The map test checks this against node:crypto, so if it is wrong it fails
 * loudly rather than quietly producing a map id nobody else agrees with.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(bytes: Uint8Array): Uint8Array {
  // Pad to a multiple of 64 bytes: a 0x80 byte, zeros, then the length in
  // bits as a 64 bit big endian integer.
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Lengths above 2^32 bits cannot occur here (that would be a 512 MB input)
  // but the high word is written anyway so the padding is correct by the book.
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen >>> 0;
  const end = padded.length;
  padded[end - 8] = (hi >>> 24) & 0xff;
  padded[end - 7] = (hi >>> 16) & 0xff;
  padded[end - 6] = (hi >>> 8) & 0xff;
  padded[end - 5] = hi & 0xff;
  padded[end - 4] = (lo >>> 24) & 0xff;
  padded[end - 3] = (lo >>> 16) & 0xff;
  padded[end - 2] = (lo >>> 8) & 0xff;
  padded[end - 1] = lo & 0xff;

  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (padded[off + i * 4] << 24) | (padded[off + i * 4 + 1] << 16) |
        (padded[off + i * 4 + 2] << 8) | padded[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += HEX[bytes[i] >>> 4] + HEX[bytes[i] & 0xf];
  }
  return s;
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/** Parse hex back to bytes. Returns null on anything malformed. */
export function fromHex(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX.indexOf(s[i * 2].toLowerCase());
    const lo = HEX.indexOf(s[i * 2 + 1].toLowerCase());
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** UTF-8 bytes of a string, for hashing a label. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
