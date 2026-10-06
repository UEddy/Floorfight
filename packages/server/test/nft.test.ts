// NFT heads, with a fake fetch standing in for Helius and for the image CDN.
// Most of this is about what the image fetch refuses, because that is the
// part that would be a server side request forgery hole if it were loose.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_BYTES,
  NftService,
  allowedImageUrl,
  fetchImage,
  imageUrlOf,
} from "../src/nft";

const KEY = "test-key-0000-1111";
const OWNER = "aZHnJuWXptMMExTbxRUFTKp56mny44ps8Rk42egaBZF";
const OTHER = "7gdfX164bnLup5LJY4TT4Hkst8NoZussV9UMdZmdkQn7";
const MINT = "G4FExRd3R4DLxjy2yUNdxg3RChio31ASm1EfWHrqxMKT";
const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/abc";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 7),
]);

function asset(over: Record<string, unknown> = {}) {
  return {
    id: MINT,
    interface: "V1_NFT",
    burnt: false,
    ownership: { owner: OWNER },
    grouping: [{ group_key: "collection", group_value: "FA7NAiBxjNWNiPN3VuWeTn5JmYWRhKsmE4dgeDdcYSLc" }],
    content: {
      metadata: { name: "Ember Clerk" },
      links: { image: "https://arweave.net/abc" },
      files: [{ uri: "https://arweave.net/abc", cdn_uri: CDN, mime: "image/png" }],
    },
    ...over,
  };
}

/** A fetch that answers DAS calls with `result` and records every URL it was asked for. */
function fakeFetch(result: unknown, image?: () => Response) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://mainnet.helius-rpc.com/")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    if (image) return image();
    throw new Error(`unexpected fetch of ${url}`);
  }) as typeof fetch;
  return { f, urls };
}

/* ------------------------------------------------------------- verify --- */

test("verify accepts a mint the wallet owns and returns its collection", async () => {
  const { f } = fakeFetch(asset());
  const nfts = new NftService(KEY, f);
  const v = await nfts.verify(OWNER, MINT);
  assert.equal(v.mint, MINT);
  assert.equal(v.collection, "FA7NAiBxjNWNiPN3VuWeTn5JmYWRhKsmE4dgeDdcYSLc");
});

test("verify gives the default face for someone else's mint, a burnt one, a token, or an error", async () => {
  const none = { mint: null, collection: null };
  assert.deepEqual(await new NftService(KEY, fakeFetch(asset()).f).verify(OTHER, MINT), none);
  assert.deepEqual(await new NftService(KEY, fakeFetch(asset({ burnt: true })).f).verify(OWNER, MINT), none);
  assert.deepEqual(
    await new NftService(KEY, fakeFetch(asset({ interface: "FungibleToken" })).f).verify(OWNER, MINT), none,
  );
  assert.deepEqual(await new NftService(KEY, fakeFetch(asset({ id: OTHER })).f).verify(OWNER, MINT), none);
  const broken = (async () => { throw new Error("network down"); }) as typeof fetch;
  assert.deepEqual(await new NftService(KEY, broken).verify(OWNER, MINT), none);
  assert.deepEqual(await new NftService(KEY, fakeFetch(asset()).f).verify(OWNER, "not a mint"), none);
  assert.deepEqual(await new NftService(KEY, fakeFetch(asset()).f).verify(OWNER, undefined), none);
});

test("a failed DAS call never carries the API key in its message", async () => {
  const leaky = (async (url: string) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  }) as unknown as typeof fetch;
  const nfts = new NftService(KEY, leaky);
  await assert.rejects(nfts.list(OWNER), (e: Error) => !e.message.includes(KEY));
});

/* --------------------------------------------------------------- list --- */

test("list returns NFTs with same origin image paths, and skips tokens and burnt ones", async () => {
  const { f } = fakeFetch({
    items: [
      asset(),
      asset({ id: OTHER, interface: "FungibleToken" }),
      asset({ id: "DPbvWhvjxqK5D23jmpMpZeSgdLWfGgJ2AwwiR8WUXpTZ", burnt: true }),
      asset({ id: "FV44XWLirwdALJykeBAfwTJ5wT69ze7wUoQ3GeLq7SFx", content: { metadata: { name: "x" } } }),
    ],
  });
  const { items } = await new NftService(KEY, f).list(OWNER);
  assert.deepEqual(items.map((i) => i.id), [MINT, "FV44XWLirwdALJykeBAfwTJ5wT69ze7wUoQ3GeLq7SFx"]);
  assert.equal(items[0].image, `/api/nft-img/${MINT}`, "never the remote URL");
  assert.equal(items[1].image, null);
});

/* -------------------------------------------------------------- image --- */

test("only https on an allowed host, default port, no credentials", () => {
  assert.ok(allowedImageUrl(CDN));
  for (const bad of [
    "http://cdn.helius-rpc.com/x.png",
    "https://cdn.helius-rpc.com:8443/x.png",
    "https://user:pw@cdn.helius-rpc.com/x.png",
    "https://cdn.helius-rpc.com.evil.example/x.png",
    "https://evil.example/cdn.helius-rpc.com/x.png",
    "https://arweave.net/abc",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/x.png",
    "https://localhost/x.png",
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "not a url",
  ]) {
    assert.equal(allowedImageUrl(bad), false, bad);
  }
});

test("an image URL from metadata on any other host is never chosen", () => {
  const a = asset({
    content: {
      links: { image: "https://169.254.169.254/latest/meta-data/" },
      files: [{ cdn_uri: "http://127.0.0.1:8080/api/matches" }],
    },
  });
  assert.equal(imageUrlOf(a), null);
});

test("the image route fetches the CDN copy and returns the bytes", async () => {
  const { f, urls } = fakeFetch(asset(), () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  const img = await new NftService(KEY, f).image(MINT);
  assert.equal(img.type, "image/png");
  assert.ok(img.body.equals(PNG));
  assert.deepEqual(urls.slice(1), [CDN], "nothing fetched but the allowed CDN URL");
});

test("an asset whose only image is off the allow list is refused without fetching it", async () => {
  const { f, urls } = fakeFetch(asset({ content: { links: { image: "https://evil.example/x.png" } } }));
  await assert.rejects(new NftService(KEY, f).image(MINT), /allowed host/);
  assert.equal(urls.length, 1, "only the DAS call, no image fetch");
});

test("redirects, wrong types, mismatched bytes and oversize bodies are refused", async () => {
  const cases: [string, () => Response, RegExp][] = [
    ["redirect", () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }), /302/],
    ["svg", () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), /refused/],
    ["html", () => new Response("<html>", { headers: { "content-type": "text/html" } }), /refused/],
    ["no type", () => new Response(PNG), /refused/],
    ["lying type", () => new Response(Buffer.from("GIF89a....."), { headers: { "content-type": "image/png" } }), /do not match/],
    ["declared too big", () => new Response(PNG, {
      headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
    }), /too large/],
    ["streamed too big", () => new Response(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]), {
      headers: { "content-type": "image/png" },
    }), /too large/],
  ];
  for (const [name, respond, err] of cases) {
    const f = (async () => respond()) as typeof fetch;
    await assert.rejects(fetchImage(CDN, f), err, name);
  }
});

test("fetchImage refuses a disallowed URL before any request is made", async () => {
  let called = false;
  const f = (async () => { called = true; return new Response(PNG); }) as typeof fetch;
  await assert.rejects(fetchImage("https://169.254.169.254/", f), /allow list/);
  assert.equal(called, false);
});

test("a key that does not look like a Helius key is refused at startup", () => {
  assert.throws(() => new NftService("x"));
  assert.throws(() => new NftService("key with spaces in it"));
});
