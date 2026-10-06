/**
 * NFT heads, through Helius DAS on mainnet.
 *
 * Three jobs, all for holders matches:
 *
 *   list    a wallet's NFTs for the head picker (getAssetsByOwner)
 *   verify  at join, does this wallet own this asset (getAsset)
 *   image   fetch an asset's image so the page can draw it in WebGL
 *
 * HELIUS_API_KEY lives in the server's environment and nowhere else. The page
 * never talks to Helius: it asks /api/nfts and /api/nft-img on this server,
 * and no response from here carries the key or the RPC URL. Errors are
 * rewritten before they leave this file, so a failed request cannot echo the
 * URL with the key in it into a log line or a reply.
 *
 * The image fetch is the dangerous one. Metadata is written by whoever minted
 * the NFT, so an image URL in it can point anywhere, including at this box's
 * own loopback or a cloud metadata address. Fetching it would be a server
 * side request forgery hole with a picture frame round it. So this never
 * fetches a URL from metadata as such. It only fetches from an allow list of
 * CDN hosts (Helius's own image CDN by default, which has already fetched and
 * cached the original), over https, on the default port, with redirects
 * refused, a timeout, a 512 KB cap enforced while reading, and a content type
 * that must be PNG, JPEG or WebP and must match the file's first bytes.
 */

/** The only hosts an image is ever fetched from. Exact match, https only. */
export const IMAGE_HOSTS: readonly string[] = ["cdn.helius-rpc.com"];

export const MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const DAS_TIMEOUT_MS = 8000;
const IMAGE_TIMEOUT_MS = 6000;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** NFT standards worth putting on a head. Fungible tokens are not faces. */
const NFT_INTERFACES = new Set(["V1_NFT", "V2_NFT", "ProgrammableNFT", "MplCoreAsset", "LEGACY_NFT"]);

export interface NftItem {
  id: string;
  name: string;
  collection: string | null;
  /** Same origin path for the image, or null if there is none worth fetching. */
  image: string | null;
}

/** The parts of a DAS asset this file reads. Everything is optional: it is someone else's JSON. */
interface DasAsset {
  id?: unknown;
  interface?: unknown;
  burnt?: unknown;
  ownership?: { owner?: unknown };
  grouping?: { group_key?: unknown; group_value?: unknown }[];
  content?: {
    metadata?: { name?: unknown };
    links?: { image?: unknown };
    files?: { uri?: unknown; cdn_uri?: unknown; mime?: unknown }[];
  };
}

type Fetch = typeof fetch;

export class NftService {
  private rpcUrl: string;

  constructor(apiKey: string, private fetchFn: Fetch = fetch, rpcBase = "https://mainnet.helius-rpc.com/") {
    if (!/^[A-Za-z0-9-]{8,128}$/.test(apiKey)) throw new Error("HELIUS_API_KEY does not look like a Helius key");
    this.rpcUrl = `${rpcBase}?api-key=${encodeURIComponent(apiKey)}`;
  }

  private async das<T>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "floorfight", method, params }),
        signal: AbortSignal.timeout(DAS_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      // Not the original error: it can carry the URL, and the URL has the key.
      throw new Error(`DAS ${method} request failed`);
    }
    if (!res.ok) throw new Error(`DAS ${method} answered ${res.status}`);
    const body = await res.json().catch(() => null) as { result?: T; error?: unknown } | null;
    if (!body || body.error || body.result === undefined) throw new Error(`DAS ${method} returned an error`);
    return body.result;
  }

  /** A wallet's NFTs, as the head picker needs them. */
  async list(owner: string): Promise<{ items: NftItem[] }> {
    if (!BASE58_RE.test(owner)) throw new Error("not a wallet address");
    const result = await this.das<{ items?: DasAsset[] }>("getAssetsByOwner", {
      ownerAddress: owner, page: 1, limit: 100,
    });
    const items: NftItem[] = [];
    for (const a of result.items ?? []) {
      const item = toItem(a);
      if (item) items.push(item);
    }
    return { items };
  }

  /**
   * Does `wallet` own `mint` right now? Returns the roster fields: the mint
   * and its collection if so, nulls otherwise. Never throws: an unreachable
   * indexer is a default face, not a refused seat somebody paid for.
   */
  async verify(wallet: string, mint: string | undefined): Promise<{ mint: string | null; collection: string | null }> {
    const none = { mint: null, collection: null };
    if (!mint || !BASE58_RE.test(mint) || !BASE58_RE.test(wallet)) return none;
    try {
      const a = await this.das<DasAsset>("getAsset", { id: mint });
      if (a.id !== mint || a.burnt === true) return none;
      if (typeof a.interface !== "string" || !NFT_INTERFACES.has(a.interface)) return none;
      if (a.ownership?.owner !== wallet) return none;
      return { mint, collection: collectionOf(a) };
    } catch {
      return none;
    }
  }

  /**
   * An asset's image, from an allow listed CDN host only. Throws on anything
   * else; the API turns that into a 502 and the page draws the default face.
   */
  async image(assetId: string): Promise<{ type: string; body: Buffer }> {
    if (!BASE58_RE.test(assetId)) throw new Error("not an asset id");
    const a = await this.das<DasAsset>("getAsset", { id: assetId });
    const url = imageUrlOf(a);
    if (!url) throw new Error("asset has no image on an allowed host");
    return fetchImage(url, this.fetchFn);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function collectionOf(a: DasAsset): string | null {
  const g = (a.grouping ?? []).find((x) => x.group_key === "collection");
  const v = str(g?.group_value);
  return v && BASE58_RE.test(v) ? v : null;
}

function toItem(a: DasAsset): NftItem | null {
  const id = str(a.id);
  if (!id || !BASE58_RE.test(id) || a.burnt === true) return null;
  if (typeof a.interface !== "string" || !NFT_INTERFACES.has(a.interface)) return null;
  const name = (str(a.content?.metadata?.name) ?? "Unnamed").slice(0, 64);
  return {
    id,
    name,
    collection: collectionOf(a),
    image: imageUrlOf(a) ? `/api/nft-img/${id}` : null,
  };
}

/**
 * The first image URL on the asset that is on an allowed host. Helius puts
 * its CDN copy in files[].cdn_uri; the original in links.image is only used
 * if it happens to be on an allowed host itself, which it almost never is.
 */
export function imageUrlOf(a: DasAsset): string | null {
  const candidates: unknown[] = [];
  for (const f of a.content?.files ?? []) candidates.push(f.cdn_uri);
  candidates.push(a.content?.links?.image);
  for (const c of candidates) {
    const s = str(c);
    if (s && allowedImageUrl(s)) return s;
  }
  return null;
}

/** https, an allowed host exactly, no port, no credentials. */
export function allowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" &&
    IMAGE_HOSTS.includes(u.hostname);
}

/** First bytes of each format, checked against the declared type. */
function sniff(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * Fetch an image from an allowed host, under every limit above. Exported for
 * the tests, which drive it with a fake fetch.
 */
export async function fetchImage(url: string, fetchFn: Fetch = fetch): Promise<{ type: string; body: Buffer }> {
  if (!allowedImageUrl(url)) throw new Error("image host is not on the allow list");
  let res: Response;
  try {
    res = await fetchFn(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { Accept: IMAGE_TYPES.join(", ") },
    });
  } catch {
    throw new Error("image fetch failed");
  }
  // A redirect could go anywhere, which is the thing the allow list is for.
  if (res.status !== 200) throw new Error(`image host answered ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new Error(`image type ${type || "missing"} refused`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new Error("image too large");

  // Read with a running total, so a host that lies about its length, or
  // sends none, still cannot hand over more than the cap.
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) throw new Error("image has no body");
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("image too large");
    }
    chunks.push(Buffer.from(value));
  }
  const body = Buffer.concat(chunks);
  if (sniff(body) !== type) throw new Error("image bytes do not match the declared type");
  return { type, body };
}

/** From the environment, or null without a key: no NFT endpoints, default faces. */
export function nftsFromEnv(env: NodeJS.ProcessEnv): NftService | null {
  const key = env.HELIUS_API_KEY;
  if (!key) return null;
  return new NftService(key);
}
