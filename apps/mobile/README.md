# Floorfight mobile shell

The Android app. It is a thin native wrapper whose entire job is to hold a
wallet and a WebView: the game itself is the page at
`https://floorfight.duckdns.org`, rendered in the WebView, and the native side
exists only so that Mobile Wallet Adapter and Seed Vault can do things a web
page cannot.

**Expo Go cannot run this.** Mobile Wallet Adapter is native Android code, so
it has to be compiled into the binary. The development build is an APK you
install once and then point at a Metro server, which is the same loop Expo Go
gives you but with native modules included.

## Two builds

`eas.json` has two Android profiles that matter, and they are for different
people.

| Profile | Who it is for | JavaScript | Needs Metro |
| --- | --- | --- | --- |
| `preview` | judges, testers, anyone installing the APK | bundled into the APK | no |
| `development` | you, while changing the shell | loaded from Metro on your machine | yes |

**`preview` is the submission APK.** It is a release build
(`:app:assembleRelease`, `developmentClient: false`), so Metro bundles the
JavaScript into the APK at build time and the app starts on its own, on any
phone, with no dev server and no computer on the same network. `expo-dev-client`
is in the plugin list, but its launcher only exists in debug builds, so it
does not appear in this one.

```sh
cd apps/mobile
eas build --profile preview --platform android
```

EAS gives you a URL for the `.apk`. That file is what goes in the submission
and what a judge sideloads. It still loads the game from
`https://floorfight.duckdns.org`, so the droplet has to be up for it to be
playable; the shell itself needs nothing else.

**`development`** is the debug build with the dev client launcher, for your
own testing. Install it once, then run Metro and JavaScript changes reload
without a rebuild:

```sh
eas build --profile development --platform android   # once, or when native deps change
npx expo start --dev-client                          # every session
```

There is also a `production` profile that makes an Android App Bundle
(`.aab`). That is the Play Store format and not what the dApp Store or a
sideload wants; leave it alone until a store asks for it.

No profile sets an update `channel`: those only mean something with
`expo-updates` installed, and it is not. Every change to the shell's
JavaScript reaches `preview` users through a new APK, which for a wallet
holding app is the right default anyway.

## What you need to set up yourself

I have not done any of this, and none of it can be done from here.

1. **An Expo account.** Sign up at <https://expo.dev>. Free is enough to
   start; EAS build minutes on the free tier are limited but a development
   build is one of them, not one per code change.

2. **EAS CLI and a login.**

   ```sh
   npm install --global eas-cli     # or use npx eas-cli everywhere below
   eas login
   ```

3. **An EAS project.** From this directory:

   ```sh
   cd apps/mobile
   npm install
   eas init
   ```

   `eas init` creates the project on your account and writes its id into
   `app.config.ts` under `extra.eas.projectId`. That id is not in the repo
   because it does not exist until an account creates it. Commit it once it
   is there.

4. **A development build, and install it on the phone.** (For the
   submission APK, see "Two builds" above: `--profile preview`.)

   ```sh
   eas build --profile development --platform android
   ```

   EAS builds it in the cloud and gives you a QR code and an APK URL. Install
   the APK on both Android phones. Rebuild only when native dependencies
   change: JavaScript changes reload over Metro.

   If you would rather build locally, you need Android Studio, the SDK and a
   JDK on the machine, and `npx expo run:android`. The droplet cannot do it
   and neither can WSL without the Windows SDK, so EAS is the path of least
   resistance here.

5. **Run Metro and connect.**

   ```sh
   npx expo start --dev-client
   ```

   Open the installed development build on the phone and point it at the
   Metro URL. The phone and the machine need to be on the same network.

6. **A wallet app that speaks MWA, on the phone.** The app asks the system for
   a wallet; if none is installed every wallet call fails with no wallet
   found. Install one that supports Mobile Wallet Adapter and set it to
   **devnet**, which is what `src/config.ts` points at.

7. **Devnet SOL in that wallet**, for stakes and fees. `solana airdrop` or a
   faucet.

8. **The game has to be reachable.** The WebView loads
   `https://floorfight.duckdns.org`. Until the droplet is deployed with Caddy
   in front of it, the app will show "Cannot reach the hall" and that is
   correct behaviour rather than a bug in the shell.

9. **The program has to be deployed and configured.** `join` reads the config
   PDA and the match account, so the escrow program needs to be deployed to
   devnet and `initialize_config` run against it. Until then escrow requests
   fail with "no match N on solana:devnet", which is also correct.

10. **The IDL copy.** `src/idl/arena.json` is a copy of `target/idl/arena.json`
    because `target/` is gitignored. After any program change:

    ```sh
    cd programs/arena && cargo build-sbf --tools-version v1.57 && cd ../..
    anchor idl build -p arena -o target/idl/arena.json
    cd apps/mobile && npm run idl:sync
    ```

    `src/escrow.ts` compares the program address in the copy against the one
    this build expects and throws at startup if they differ, so a stale copy
    fails loudly instead of quietly building transactions for the wrong
    program.

Publishing to the Solana dApp Store is a separate exercise: it needs a
publisher NFT, a signed submission and the real-money question in CLAUDE.md
settled first. Not yet.

## The trust boundary, pointing the other way

The game server treats the phone as hostile. This app treats the page the same
way, for the same reason: the WebView is remote content fetched over the
internet, and a page that can ask the native side for a signature is one
scripting bug away from asking for the wrong one.

**The page sends intents. It never sends bytes.**

There are exactly three requests, all in `src/bridge.ts`:

| Request | What the page sends | What the native side does |
| --- | --- | --- |
| `connect` | `{ id, t }` | Authorises with the wallet and returns its address. Signs nothing |
| `signJoin` | `{ id, t, v, matchId, nonce }` | Builds `floorfight:join:v<N>:<matchId>:<nonce>` itself, checks the result against a strict pattern, signs that and nothing else |
| `escrow` create | `{ id, t, action: "create", tier }` | Looks the stake up in its own fixed tier list (`src/config.ts`, devnet 0.01, 0.05, 0.1 SOL), generates a random u64 match id, builds `create_match` plus `join_match` into one transaction, shows the amount, then opens the wallet. Replies with the match id it generated |
| `escrow` join, claim, refund | `{ id, t, action, matchId }` | Reads the match account, decides whether the action is possible, builds the instruction from the IDL, shows the amount (for a claim with a connected wallet, that wallet's exact payout), then opens the wallet |

There is deliberately no request carrying a transaction, a message, a byte
array, an instruction, an account list, a program id or a lamport amount. If
the page could hand over any of those, every check in `bridge.ts` would be
decoration. Adding one is not an acceptable shortcut, for the same reason the
game protocol has no message that asserts a kill.

What enforces it:

- **Origin check first.** `onMessage` reads the URL of the frame that posted
  the message and drops anything not under `GAME_ORIGIN`, before parsing.
- **Navigation lock.** `onShouldStartLoadWithRequest` refuses any URL off the
  origin, so the page cannot replace itself with something else and keep the
  bridge.
- **Strict parsing.** Exact field sets, integer checks, and a pattern per
  string. An unknown request type, an extra field or a string with a space in
  it is refused, not coerced.
- **The join message is built, not accepted.** The page supplies a match id
  and the nonce it was given; the template is this side's. Nothing matching
  that template can be a Solana transaction, which is the other thing an
  off-chain signing path has to be sure of.
- **Amounts come from the chain.** `src/escrow.ts` reads the stake and the
  payouts off the match account. A page that wanted to show somebody a 0.01
  SOL stake and have them sign away 10 would have to change the chain to do
  it.
- **The sheet comes before the wallet.** `Confirm.tsx` shows the action, the
  match, the amount and the direction, and only then does MWA open.
- **No file access, no other origins, no new windows,** and no permissions
  beyond network in the manifest.

The web client uses this bridge for holders matches (`packages/client/src/native.ts`). The contract is:

```js
// Ask:
window.ReactNativeWebView.postMessage(JSON.stringify({
  id: "j1", t: "signJoin", v: 5, matchId: "12345", nonce: nonceFromServer,
}));

// Listen:
window.addEventListener("floorfight-native", (e) => {
  const reply = JSON.parse(e.data);   // { id, ok, ... }
});
```

Replies are delivered as a `floorfight-native` event rather than a `message`
event so that nothing else listening for `message` on the page can see them.

## Layout

```
App.tsx              status bar and the WebView, nothing else
index.ts             Expo entry point
app.config.ts        Android only, landscape, no permissions beyond network
eas.json             development, preview and production build profiles
src/polyfills.ts     Buffer and getRandomValues, imported first
src/config.ts        the origin, the cluster, the program id. Not runtime configurable
src/bridge.ts        the requests, and every check that makes them safe
src/wallet.ts        MWA: one function to sign a message, one to send a transaction
src/escrow.ts        reads match accounts and builds create, join, claim and refund from the IDL
src/GameWebView.tsx  the WebView with the shutters down
src/Confirm.tsx      what you are approving, before the wallet opens
src/idl/arena.json   a copy of the build artifact. npm run idl:sync
```

## Tests

The bridge has tests, because it is the part that decides what gets signed.
They are pure: no device, no wallet, no network, no Metro.

```sh
cd apps/mobile
npm install
npm test        # the bridge: what is accepted, what is refused
npm run check   # type checks the app and the tests
```

They cover both halves of the rule. On the accepted side, the two real
requests. On the refused side: `signMessage`, `signTransaction`,
`signAndSendTransaction`, `signBytes`, `transfer`, an escrow request carrying
its own lamport amount, an unknown action, an extra field, every malformed
field, nine ways of spelling an origin that is not the game, and a reply
payload full of string terminators.

Writing them turned up one real hole, since fixed: `JSON.stringify` leaves
U+2028 and U+2029 as themselves, and both are line terminators in JavaScript
source, so a reply carrying one could have ended the statement it was supposed
to be a string inside. Current WebViews tolerate them in string literals;
betting a wallet on the engine being new enough is not a trade worth making.

## Notes on the versions

Pinned to Expo SDK 57, which pairs with React Native 0.86.3 and React 19.2.3,
and to Mobile Wallet Adapter 2.3.0. Those were current when this was written.

Two of the pins are deliberately **not** the newest on npm, because Expo's own
`bundledNativeModules.json` for SDK 57 asks for older ones and that file is
the authority for anything with native code in it:

| Package | Pinned | npm latest |
| --- | --- | --- |
| `react-native-webview` | 13.16.1 | 14.0.1 |
| `react-native-get-random-values` | 1.11.0 | 2.0.0 |

Installing 14.0.1 made every WebView prop a type error, which is what sent me
to that file in the first place. If `npm install` complains or `expo-doctor`
flags a mismatch:

```sh
npx expo install --fix
```

which resets the Expo managed packages to whatever the installed SDK wants.
Two API details worth knowing if a wallet call fails outright, because they
have moved between MWA versions and the current docs are the authority rather
than this file:

- `authorize` takes `{ chain, identity }` here. Older versions took `cluster`.
- `signMessages` returns the payload with the signature appended, per the MWA
  spec. `src/wallet.ts` handles both that and a bare 64 byte signature, and
  refuses anything else rather than guessing.

## What has been checked, and what has not

Checked: the dependency set installs cleanly, the app and the tests both type
check against the real SDK 57 tree, and the bridge and tier tests pass.

Not checked, and not checkable from here:

- No EAS project exists, no build has been made, and nothing has run on a
  phone or against a wallet. Everything in the setup list above is still to
  do.
- The MWA calls themselves are unexercised. `authorize`, `signMessages` and
  `signAndSendTransactions` are typed against the installed package, which
  catches the wrong shape but not the wrong semantics.
- No transaction has been built against a deployed program, because the
  program is not deployed. `src/escrow.ts` derives the PDAs and encodes the
  instructions through the IDL, and the IDL address check will catch a stale
  copy, but the first real `join` is the first real test of it.
- Seed Vault is not wired up. CLAUDE.md has the native layer owning both it
  and Mobile Wallet Adapter; this is the MWA half. Seed Vault is a separate
  API for devices that have it, and on a device that does not, MWA is the
  whole story anyway.
Also worth knowing:

- `claim` and `refund` are the same on-chain instruction; the program decides
  which it is from the match state. They are separate actions in the bridge
  because what the person is approving differs, and because this side can say
  in advance when neither applies.
- The claim sheet shows what the match pays for first, second and third rather
  than the exact figure for the wallet about to sign, because the slot is not
  known until the wallet authorises, which happens after the sheet.
