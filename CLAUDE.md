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

**Match format.** Six player free-for-all, 90 second rounds, pot split 50/30/20.

**Packages.** `packages/shared` holds `sim.ts` and `protocol.ts`, imported by
both server and client. That sharing is the point: prediction, authority and
replay must run identical code.

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

## Performance budget

Measured: the greybox test holds 60 fps with a 60 fps 1% low on a Galaxy S24 at
full quality, 31 draw calls. That scene is roughly a twentieth of the real game,
so the headroom is real but unearned.

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

Done: deterministic sim core, wire protocol, greybox feel test, server tick
loop and join handshake, Anchor escrow program with 17 LiteSVM tests covering
the attack cases and payout paths.

Next: Playable client with dev room, then droplet deploy, then Expo shell and MWA.
