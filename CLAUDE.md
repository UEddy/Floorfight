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
- 90 messages a second per socket, sustained, as a token bucket holding
  300, so the backlog a phone sends after a mobile data stall gets through.
  The old rule, a counter reset to 90 once a second, kicked a one second
  4G stall about half the time and anything from a second and a half up
  always; that was the "Connection lost" in the middle of a match. While a
  socket is stalled the client also holds inputs back and sends them in
  one message, up to nine at a time, rather than sixty a second.

Every close the server starts is logged as `[close]` with the match, the
slot, the address and the reason; closes from the other end are logged with
their WebSocket code (1006 is a connection that died, the usual one on
mobile data). The client shows a kick's reason instead of a generic "lost",
and after a drop it reconnects on its own into the same match and the same
seat, with a "Reconnecting" pill, for about half a minute: a guest signs
again with the key it kept for the page, a holder's wallet is asked again.

None of it stops a botnet. It stops the cheap things, and it makes the failure
mode "that address is refused" rather than the kernel killing the process.

The address a connection is charged to comes from `X-Forwarded-For` only when
the TCP peer is `127.0.0.1`, which behind Caddy it always is. From anywhere
else the header is ignored completely. When the header is a list the
**rightmost** entry is used, because Caddy appends what it saw: reading the
leftmost, which is the usual way this gets written, would let any client pick
its own bucket by sending a header.

`npm run measure` in `packages/server` starts the server the way the droplet
runs it (production, a 256 MB heap), fills four rooms with signing guests for
forty seconds and reports resident memory and the largest snapshot. On the
96 block hall: 97 MB idle, 119 MB loaded, snapshots at most 861 bytes for six
players (the 48 block hall measured 104 MB idle, 105 to 125 MB loaded).

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

Three, in `shared/weapons.ts`, at 100 health:

| | damage | rounds/min | spread | mag | reload | body kill | head kill |
|---|---|---|---|---|---|---|---|
| Rifle | 20, head 35 | 514 | 2.6 deg | 30 | 1.5 s | 5 (467 ms) | 3 (233 ms) |
| Pistol | 40, head 100 | 277 | 0.6 deg | 12 | 1.25 s | 3 (433 ms) | 1 |
| Shotgun | 8 x 11, no head bonus | 100 | 8.8 deg | 6 | 2.5 s | 2 up close (600 ms) | 2 |

The shotgun never kills in one and kills in two out to about five blocks,
and stops dead at sixteen. The rifle and pistol reach 140, past the hall's
longest line. `npm run weapons` in `packages/server` prints this table from
the code and the shotgun's damage by distance from the real sim. Magazine, reload, fire interval,
damage, head multiplier, spread, pellet count and range all live in that
table, and the server is the only thing that acts on it.

Recoil is sim state too. Each shot lifts the aim by the weapon's kick, up to
a ceiling, and pushes it sideways along a fixed sway pattern; once the trigger
rests it settles back. The shot goes where the input points plus that offset,
so pulling down against the climb is the skill, and the server is the one
that applies it. The client runs the same `recoilShot` and `recoilSettle`
over its own shots and turns the camera by exactly the result, which keeps
the crosshair on the next shot. A test holds the two to the same numbers
tick for tick.

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

## The Hall

`shared/map.ts`, authored by hand as box, air and stair ops, 96 by 96 blocks
and 24 high. The map id is sha256 of the grid bytes, so any edit to a block
changes it, and a log from another layout refuses to replay.

An open exhibition hall rather than a maze: a central nave about 40 blocks
wide with a fountain court in its middle, a bandstand at the north end and a
court of engines at the south, iron columns down both sides of the nave, a
market of stalls in the west aisle and a garden of hedges in the east. Three
galleries (west, north, east) one storey up, each reached by six block wide
staircases, with six block wide covered arcades under the side two. Five
combat zones are named in `ZONES`.

The layout rules are tests, not intentions (`server/test/mapcheck.ts` and the
map tests in `sim.test.ts`):

- no pocket narrower than four blocks anywhere a player can stand, and the
  arcades six wide the whole way;
- every level, zone and spawn reachable on foot without jumping;
- at least twelve spawns (there are fourteen), none in sight of another, each
  with cover within five blocks and a fight within six seconds' walk at full
  speed;
- long lines down and across the nave stay open.

Respawn (`pickSpawn` in `sim.ts`) prefers a spawn no living enemy can see,
then the one farthest from the nearest enemy. It is part of the sim and runs
in the replay, so it reads only the world state.

`npm run topdown -- out.png` in `packages/server` draws the plan straight from
the grid, with spawns and zones marked. `docs/screenshots/map-v2/` holds that
plan and the shots views.

## Characters

`client/src/characters.ts`. A holder whose NFT the server verified is dressed
as it: the art on the front of the head, the colour round its edge on the
sides and back, the body in the art's strongest colours. Everyone else is one
of six original built in characters (Rex, Noir, Kick, Ember, Bronze, Nova),
drawn here as 16 pixel head faces and box outfits. None of them is a copy of
any collection, and no collection's art ships in the app: holders bring their
own, which is the licensing line under "Open, not yet decided".

Movement is a procedural rig, no animation library: two part legs that
stride in the direction of travel relative to the body (so strafes step
sideways and backpedals step back), knees that fold on the swing, cadence
from speed, hips that drop twice a stride, lean into acceleration and
strafe, a tuck in the air and a crouch on landing, a shuffle when turning on
the spot, breath at rest, an arm kick on firing and a flinch away from a
hit. Skeletal animation was the alternative and was turned down: it needs
rigged, licensed models and gives up the instancing. All cosmetic; the sim
never reads it, and the body and head stay inside the hitbox circle.

## Trust boundary

This is the part that must not erode under deadline pressure.

The client sends input intents. It never sends positions, never sends hits,
never sends kills, never sends scores. If a value could be produced by a phone,
it is hostile. There is deliberately no message in the protocol that lets a
client assert an outcome, and adding one is not an acceptable shortcut.

Everything else follows from that:

- Hit registration is server side, with lag compensation rewinding to the
  shooter's timestamp, clamped at 500 ms (see MAX_REWIND in `sim.ts` for why,
  and for what that costs the player being shot). `test/lagcomp.test.ts`
  plays a perfect aimer against a strafing target at 0, 150 and 250 ms round
  trip; at the old 250 ms clamp the 250 ms player hit 18% of shots, now all.
  Every match logs a `[match]` line at the end with, per slot, shots, hits,
  shots whose rewind was clamped, hits refused because the victim was in
  cover by then, rejected inputs and reconnects.
- NFT character ownership is verified server side at join, through Helius DAS
  getAsset. A client claiming a mint it does not hold gets the default face,
  not an error. The mint is not part of the signed join message: the worst a
  tampered one can do is change a face, and the ownership check catches that.
- Join carries a wallet signature over a server-issued nonce, so a captured
  join frame cannot be replayed by a third party.
- Any aim assist is computed server side and applied identically to every
  player. Client-side aim assist in a staked match is a cheat vector.
- Firing, reloading and swapping weapons are intent bits. The magazine, the
  interval, the recoil, the spread, what the shot hit and how much it hurt are all decided
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

The Hall is counted, not measured. Its exposed block faces are 55296
triangles; a greedy mesher merges runs of faces that share a tile and a flat
baked light (or light that only varies across the run), which brings the hall
to about 39.7k, split into 32 by 32 chunks so the ones behind the camera are
culled. The merge is lossless: faces inside a lantern's pool or a corner's
occlusion stay single, which is why it is not a bigger cut. Everything
samples one procedural texture atlas, with sky and lantern light baked into
vertex colours. With the sign strip, the sky dome, the glass roof, the props,
the lantern glows, the instanced character parts, the view model, the death
chunks, the tracers and the remote muzzle flashes, a six player frame is
36 to 39 draw calls and 59k to 64k triangles (characters are 19 instanced
meshes, whatever the player count), read off the renderer by
`npm run shots` in headless Chromium. The 48 block hall before it was 22
draw calls and 51k triangles.

`npm run shots` in `packages/client` plays five seconds against bots and saves
screenshots from fixed places in the Hall, printing the draw calls and
triangles at each. Use it to look at a visual change
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

On the droplet, `deploy/floorfight.service` is free play only and names no
key. Staked rooms are the drop-in `deploy/floorfight-chain.conf`, which adds
the three chain settings together and an optional root only
`/etc/floorfight/helius.env` for `HELIUS_API_KEY`. Without that key there are
no NFT heads and every holder wears the default face; it never leaves the
server.

The same port serves read only JSON under `/api`, which Caddy proxies:
`/api/matches?tier=N` and `/api/match/:id` from the chain, `/api/nfts/:owner`
and `/api/nft-img/:assetId` through Helius DAS. All are rate limited per
address and cached for a few seconds. The image route only ever fetches from
the allow listed CDN hosts in `nft.ts`, never a URL out of metadata.

`npm run init-config` and `npm run show-config` at the repo root set up and
read the program config. init-config runs on your own machine with the
deployer key, defaults to devnet, and refuses mainnet without `--mainnet`.

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
block grid collision and grid hitscan, wire protocol v7 with horizontal acceleration and honest crosshair bloom, The Hall (96 by 96,
open nave, three galleries, fourteen spawns) as authored map data identified
by the hash of its own blocks, respawn away from enemies, bots that hunt, merged block renderer with
hit feedback, damage numbers, death chunks, tracers and synthesized sound,
touch controls, server tick loop and join handshake, free and staked room
types with server side bots, Anchor escrow program with 20 LiteSVM tests
covering the attack cases, the payout paths and the holders flow (the app's
create transaction, the lobby's lock rule against the real program, and
create, join, lock, settle and claim end to end), 145 server tests covering
replay determinism against a pinned golden result (`test/golden.json`,
regenerated only on purpose with `npm run golden`), lag compensation at
mobile round trips, reconnecting into the same seat, the message budget
under 4G stalls, weapon behaviour, the map id, the map's spawn, width,
openness and reachability rules, respawn placement, the bot rules, the holders lobby and API, and the NFT
image fetch's SSRF limits.

Holders matches, wired: a mode screen (Free or Holders), connect through the
app, stake tiers (devnet 0.01, 0.05, 0.1 SOL, fixed in the app), open matches
listed from chain, create (create_match plus join_match in one transaction,
match id generated natively) or join, a lobby that locks when everyone who
staked is connected or with 60 seconds of the join window left, a staked room
with no bots, and a results screen with Claim or Refund and the log link.
NFT heads for holders through DAS. None of it has run against devnet or a
wallet yet.

Wired, untested on devnet: free rooms with guest keys and bot fill, staked
rooms opening from a Locked match account, settlement with backoff, match logs
on disk and the replay script. The chain half is covered by LiteSVM tests, not
by anything that has talked to devnet.

Scaffolded, unbuilt: `apps/mobile`, the Expo shell. Android only, Expo SDK 57,
a WebView pointed at the production origin, and a native bridge that accepts
exactly two requests from the page and refuses everything else. It type checks
and its bridge tests pass, but no EAS project exists and nothing has run on a
phone. `apps/mobile/README.md` lists what has to be set up by hand.

Next: droplet deploy, deploy the program to devnet and run
`npm run init-config`, then `eas build --profile preview` for the submission
APK, then the first real holders match on devnet with two phones.
