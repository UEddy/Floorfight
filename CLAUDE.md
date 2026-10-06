# Floorfight

Floorfight is a mobile multiplayer arena shooter on Solana. Players stake SOL into a match, top
three split the pot. Playable characters are Solana NFTs, resolved by verified
on-chain ownership rather than by anything the client claims.

Entry for the Solana Mobile CLOCK IN hackathon.

The Anchor program is still named `arena`, with its existing program ID, on
purpose. Renaming it changes the IDL and the generated client, which is not
worth doing before deploy.

## Hard deadline

Submissions close **8 October 2026**. Four deliverables, all mandatory:

- a functional Android APK
- this public GitHub repo
- a demo video of the app in use
- a pitch deck

Judged on stickiness and product-market fit, user experience, innovation, and
presentation. Winners must publish to the Solana dApp Store to claim a prize,
so nothing in the build may make the app unpublishable there.

There is a separate $10,000 prize for a meaningful SKR integration.

## Locked decisions

Do not reopen these without asking. They were made deliberately.

**Client.** TypeScript and Three.js rendering to WebGL, running in a WebView
inside an Expo / React Native shell. The React Native layer owns Mobile Wallet
Adapter and Seed Vault. The WebView owns the render loop. They talk over
postMessage. Rejected: Unity (multi-gigabyte Windows toolchain, fat APK, no
browser iteration), Godot (no Solana or MWA path, bridge would be hand-rolled).

**Server.** Node and TypeScript, authoritative, on a DigitalOcean droplet in
Frankfurt. Simulates at 60 Hz, ships snapshots at 20 Hz.

**Chain.** Anchor program. One escrow PDA per match. Resolver signs the result.
Timeout refund path if it never does.

**Two kinds of room.** Free and staked. A free room accepts any key that signs
the server's nonce, fills what is left with bots after a few seconds and opens
a fresh one behind it when it fills; the client makes up a guest key per page
load and never stores it. A staked room opens only for a match the chain says
is Locked, takes its roster from that account in slot order, and settles to it.
Free play is the product that works without a wallet, and it is also where the
trust boundary gets exercised before there is money on it.

**Match format.** Six player free-for-all, 3 minute rounds, pot split 50/30/20.

**Packages.** `packages/shared` holds `sim.ts` and `protocol.ts`, imported by
both server and client. That sharing is the point: prediction, authority and
replay must run identical code.

## Caps

Public deploy limits, in `packages/server/src/limits.ts`. The constants are
the policy; each has an environment override so a limit can be moved on the
droplet without a deploy, and so a test does not have to open two hundred
sockets.

- 8 live sockets per address, 200 in total.
- 20 live rooms, of which free play may use 16. The reserve is so a staked
  match, which has money in escrow, can always open.
- 10 seconds to finish the join handshake, then the socket is closed.

None of it stops a botnet. It stops the cheap things, and it makes the failure
mode "that address is refused" rather than the kernel killing the process.

The address a connection is charged to comes from `X-Forwarded-For` only when
the TCP peer is `127.0.0.1`, which behind Caddy it always is. From anywhere
else the header is ignored completely. When the header is a list the
**rightmost** entry is used, because Caddy appends what it saw: reading the
leftmost, which is the usual way this gets written, would let any client pick
its own bucket by sending a header.

Twenty rooms is a ceiling, not a capacity claim. Twenty full rooms is 120
players at 60 Hz and about 8 MB of match log objects each, against a 256 MB
heap on 1 vCPU. CPU or memory will complain first.

## Match logs

The canonical log of every match is written to `/var/lib/floorfight/logs/<matchId>.json`
and served read only by Caddy at `/logs/`. It is the exact bytes that were
hashed, so the sha256 of the file is the hash written on chain with the payout.
About 2.5 MB for a three minute six player round.

`npm run replay -- <url or path>` downloads one, checks the file is in
canonical form, checks the map id matches this build, re-runs the simulation
over the recorded inputs and compares the standings it produces with the ones
recorded. With `--rpc` and `--program` it also checks the hash against the
settled match account. It takes no key and writes nothing, which is the point:
anyone can run it against somebody else's match.

## Weapons

Three, in `shared/weapons.ts`: an automatic rifle, a semi-automatic pistol
that kills with one head shot, and an eight pellet shotgun whose range stops
well short of the hall's longest sightline. Magazine, reload, fire interval,
damage, head multiplier, spread, pellet count and range all live in that
table, and the server is the only thing that acts on it.

Pellet spread comes from hashing (salt, tick, slot, pellet index), never
`Math.random`. A replay has to be able to derive every random looking number
the match used from values the log already contains, and all four are in it.

The salt is commit and reveal. A staked room draws 32 random bytes when it is
created, before anyone has joined, and sends sha256 of them in every accepted
message. The bytes themselves go out in the `over` message and into the match
log when the round ends, and the log hash on chain covers them. So nobody can
know the pattern in advance, and the server cannot pick one afterwards to suit
the result. The client checks the reveal against its own recorded commitment
and says so on the end of round card. Free rooms use a fixed public salt:
there is nothing to win and nobody to convince.

## Trust boundary

This is the part that must not erode under deadline pressure.

The client sends input intents. It never sends positions, never sends hits,
never sends kills, never sends scores. If a value could be produced by a phone,
it is hostile. There is deliberately no message in the protocol that lets a
client assert an outcome, and adding one is not an acceptable shortcut.

Everything else follows from that:

- Hit registration is server side, with lag compensation rewinding to the
  shooter's timestamp, clamped at 250 ms.
- NFT character ownership is verified server side by RPC at join. A client
  claiming a mint it does not hold gets the default skin, not an error.
- Join carries a wallet signature over a server-issued nonce, so a captured
  join frame cannot be replayed by a third party.
- Any aim assist is computed server side and applied identically to every
  player. Client-side aim assist in a staked match is a cheat vector.
- Firing, reloading and swapping weapons are intent bits. The magazine, the
  interval, the spread, what the shot hit and how much it hurt are all decided
  server side, and the damage numbers on screen are the server's own, read off
  its hit events.
- The full accepted input log hashes to a value committed on chain with the
  payout. Anyone can re-run the simulation over the log and verify the winner.
  This does not make settlement trustless. It makes it auditable. Say the
  honest version in the pitch, never claim trustless.

Determinism is a security property here, not a nicety. `sim.ts` uses only exact
double arithmetic and a quantised angle lookup table, because `Math.sin` is not
bit-specified and a replay that disagrees with the server by one ulp cannot
settle a bet.

## Secrets

The repo is public from the first commit.

- Never commit a keypair, seed phrase, `.env`, or RPC URL containing an API key.
- The resolver key lives only as an environment variable on the droplet. It is
  never in the repo, never in the APK, never in a test fixture.
- If a secret ever lands in a commit, rotating it is the fix. Deleting the file
  in a later commit does not remove it from history.
- The program upgrade authority is a separate key from the resolver.
- Dev mode (`ARENA_DEV=1`) is for a laptop. It never runs on a machine that
  holds the resolver key: the dev roster keys are public, so a dev room is
  open to anyone who can reach the port. The server refuses to start with
  `ARENA_DEV` set alongside either `NODE_ENV=production` or a resolver key, so
  that rule is enforced rather than remembered. The droplet now runs without
  it, because free play needs no dev mode.
- The resolver key is a file on the droplet at `/etc/floorfight/resolver.json`,
  named by `RESOLVER_KEYPAIR_PATH`. The server reads its mode at startup and
  refuses to start if group or others can read it. Never in the repo, never in
  the APK, never in a fixture.
- Staked rooms need `RPC_URL`, `PROGRAM_ID` and `RESOLVER_KEYPAIR_PATH`
  together. One or two of the three is a configuration error and the server
  refuses to start: a server that takes stakes with no way to settle them is
  worse than one that will not come up.

## Performance budget

Measured: the greybox test held 60 fps with a 60 fps 1% low on a Galaxy S24 at
full quality, 31 draw calls. That scene was a fraction of the real game, so the
headroom was real but unearned.

The Hall replaces it and is counted, not measured: 16485 solid blocks reduce to
36668 triangles once hidden faces are dropped, in one merged mesh that samples
a single procedural texture atlas, with sky and lantern light baked into its
vertex colours. With the sign strip, the sky dome, the glass roof, the props,
the lantern glows, the instanced character parts, the view model, the death
chunks, the tracers and the remote muzzle flashes, a six player frame is about
23 draw calls and 51k triangles, read off the renderer by `npm run shots` in
headless Chromium. It does not grow with the map or the player count.

`npm run shots` in `packages/client` plays five seconds against bots and saves
screenshots from fixed places in the Hall. Use it to look at a visual change
before shipping it. Its frame rate is SwiftShader's and means nothing.

Frame rate on device is still unmeasured, on either phone. `?debug=1` puts fps,
the 1% low, draw calls, triangles and the server measured ping on screen, so
measuring it is now a matter of loading the page on the S10 and reading them
off. Do that before trusting any number in this section.

Hold to: 60 fps floor, under 150 draw calls, instanced geometry for players, no
dynamic shadows, fixed polygon ceiling per character. Re-measure on the Galaxy
S10 before trusting any of this. The S10 is the floor, not the S24.

## Environment

- Windows host, development in WSL2 Ubuntu. Repo lives at
  `/mnt/c/Users/Eddy/dev/arena`, which is the Windows drive mounted, so git
  operations are slower than on the WSL filesystem.
- WSL interop is disabled. Do not try to launch Windows executables from WSL.
- Phone testing goes through GitHub Pages on the repo, or a dev server on
  localhost reached from the Windows browser. Both phones are Android.
- Mains power is unreliable, so nothing that must run continuously can live on
  the local machine. That is what the droplet is for.
- The droplet is 1 vCPU and 512 MB. Build artifacts locally and ship them; do
  not run heavy builds there. Node needs heap tuning at that size.
- `anchor build` fails on this machine with an edition2024 error because the
  bundled platform-tools ship an old rustc. Use
  `cargo build-sbf --tools-version v1.57` and deploy the resulting `.so`.
- `anchor test` calls `anchor build`, so it fails too. Build, generate the
  IDL and run the LiteSVM tests from the repo root instead:

  ```
  cd programs/arena && cargo build-sbf --tools-version v1.57 && cd ../..
  anchor idl build -p arena -o target/idl/arena.json
  npm test
  ```

  The test script sets `NODE_OPTIONS=--no-experimental-strip-types` because
  Node 24 otherwise loads the `.ts` file itself as an ES module and the
  `@coral-xyz/anchor` import fails. LiteSVM is pinned at 0.8.0, the last
  release built on web3.js, which the Anchor TypeScript client needs.

## Installing the server

On the droplet, in `packages/server`:

```
npm ci --omit=dev --omit=optional
```

`--omit=optional` keeps `bufferutil` and `utf-8-validate` off the box. They are
optional native speedups for `ws`, arriving as optional dependencies of
`rpc-websockets` via `@solana/web3.js`, and `ws` has JavaScript fallbacks for
both. The alternative is node-gyp and a compiler on a 512 MB box to make frame
masking marginally faster for a couple of hundred sockets.

That flag cannot live in an `.npmrc`: `omit` is an array config and a command
line `--omit` replaces the file's value rather than adding to it, so
`omit=optional` in a file silently stops applying the moment anyone passes
`--omit=dev`. Tested, not assumed.

Both lockfiles have to stay in sync with their package.json or `npm ci` refuses
to run at all. After changing a dependency, regenerate with
`npm install --package-lock-only` in that package and commit the result. A test
checks the two optional natives are still in the server lock and still marked
optional, because the way this broke was the lock quietly losing an entry.

## Running the server

```
# free play only, which is a laptop or a play-testing box
npm --prefix packages/server start

# plus staked rooms, which needs all three
RPC_URL=https://api.devnet.solana.com \
PROGRAM_ID=HoktNWjdhuts9nzV76UyqUn6FCqJ57LwAizFYbjD4TCe \
RESOLVER_KEYPAIR_PATH=/etc/floorfight/resolver.json \
LOG_DIR=/var/lib/floorfight/logs \
npm --prefix packages/server start
```

`ARENA_DEV=1` adds the fixed seat dev room for two tabs with known keys, and
refuses to coexist with a resolver key or with `NODE_ENV=production`.
`FREE_FILL_MS` is how long a free room waits for company before taking bots,
8000 by default. `MAX_PER_IP`, `MAX_CONNECTIONS`, `MAX_ROOMS`,
`MAX_FREE_ROOMS` and `JOIN_DEADLINE_MS` override the caps above.

Local play counts as one address: eight tabs on one machine is the per address
cap, because the loopback peer with no forwarded header is the address.

A free only server never imports `@solana/web3.js`: `chainrpc.ts` is loaded
dynamically and only when a resolver is configured. On the droplet that is the
difference between a two second start and a twelve second one, on a box with
512 MB.

## Style

Plain, direct prose in comments and copy. No em dashes or en dashes anywhere in
the codebase or site copy. Comments explain why a thing is the way it is,
especially where the reason is a security constraint that looks like an
overcomplication.

## Open, not yet decided

Flag these rather than deciding alone.

- Whether real-money wagering is publishable on the Solana dApp Store. If it is
  not, staking gets gated to a demo tournament and the app ships free to play.
- Per-collection NFT licensing. Most Solana collections are not CC0. Holder
  gating is the intended answer, but each collection still needs checking.

## Status

Done: deterministic sim core with height, gravity, jumping and three weapons,
block grid collision and grid hitscan, wire protocol v7 with horizontal acceleration and honest crosshair bloom, The Hall as authored
map data identified by the hash of its own blocks, merged block renderer with
hit feedback, damage numbers, death chunks, tracers and synthesized sound,
touch controls, server tick loop and join handshake, free and staked room
types with server side bots, Anchor escrow program with 17 LiteSVM tests
covering the attack cases and payout paths, 42 server tests covering replay
determinism, weapon behaviour, the map id, the map's sightline and
reachability rules, and the bot rules.

Wired, untested on devnet: free rooms with guest keys and bot fill, staked
rooms opening from a Locked match account, settlement with backoff, match logs
on disk and the replay script. The chain half is covered by LiteSVM tests, not
by anything that has talked to devnet.

Scaffolded, unbuilt: `apps/mobile`, the Expo shell. Android only, Expo SDK 57,
a WebView pointed at the production origin, and a native bridge that accepts
exactly two requests from the page and refuses everything else. It type checks
and its bridge tests pass, but no EAS project exists and nothing has run on a
phone. `apps/mobile/README.md` lists what has to be set up by hand.

Next: droplet deploy, deploy the program to devnet and run `initialize_config`,
then the EAS development build, then wiring the web client to the native
bridge.
