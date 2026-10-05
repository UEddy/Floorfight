// What the droplet installs.
//
// These read the lockfile and the service unit as files. No network, no npm,
// no install: the point is to catch the shape of a problem that has already
// happened once, cheaply enough to run on every test pass.
//
// What happened: the server lock lost its bufferutil entry while keeping
// utf-8-validate, and `npm ci` on the droplet refused to run at all because
// package.json and the lock disagreed. It had also been carrying the whole
// @coral-xyz/anchor tree for a dependency that was removed a commit earlier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(SERVER_DIR, "../..");

interface LockEntry {
  version?: string;
  optional?: boolean;
  dev?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface Lock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

function lock(file: string): Lock {
  return JSON.parse(readFileSync(file, "utf8")) as Lock;
}

const serverLock = lock(path.join(SERVER_DIR, "package-lock.json"));
const serverPkg = JSON.parse(
  readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"),
) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

/**
 * The two optional native speedups for ws.
 *
 * They arrive as optional dependencies of rpc-websockets, which comes from
 * @solana/web3.js. ws works without either of them.
 */
const NATIVE_SPEEDUPS = ["bufferutil", "utf-8-validate"];

test("every direct dependency is in the server lockfile", () => {
  // The check npm ci does before it will install anything. Doing it here
  // means a stale lock fails in a test run rather than on the droplet.
  for (const name of Object.keys(serverPkg.dependencies)) {
    assert.ok(
      serverLock.packages[`node_modules/${name}`],
      `${name} is a dependency but has no entry in packages/server/package-lock.json. ` +
      "Run npm install --package-lock-only in packages/server and commit the result.",
    );
  }
  for (const name of Object.keys(serverPkg.devDependencies)) {
    assert.ok(
      serverLock.packages[`node_modules/${name}`],
      `${name} is a devDependency with no lockfile entry`,
    );
  }
});

test("the lockfile carries no tree for a dependency that was removed", () => {
  // @coral-xyz/anchor was a server dependency for one commit and then was
  // not. The lock kept its whole subtree, which is how a lock drifts out of
  // sync without anybody noticing.
  const declared = new Set([
    ...Object.keys(serverPkg.dependencies),
    ...Object.keys(serverPkg.devDependencies),
  ]);
  assert.equal(declared.has("@coral-xyz/anchor"), false, "anchor is not a server dependency");
  assert.equal(
    serverLock.packages["node_modules/@coral-xyz/anchor"],
    undefined,
    "the lock still has an anchor tree: regenerate it",
  );
});

test("the native ws speedups are present in the lock and marked optional", () => {
  // Present, so npm ci's sync check passes. Optional, so --omit=optional
  // leaves them out and the droplet never needs a compiler.
  for (const name of NATIVE_SPEEDUPS) {
    const entry = Object.entries(serverLock.packages)
      .find(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
    assert.ok(entry, `${name} has no lockfile entry, so npm ci will refuse to run`);
    assert.equal(
      entry![1].optional, true,
      `${name} is not marked optional, so --omit=optional would not exclude it`,
    );
  }
});

test("nothing the droplet must install is one of those native modules", () => {
  // Belt and braces on the above: if either of them ever became a real
  // dependency of something in the production tree, omitting optionals would
  // stop working and the install would start needing node-gyp.
  for (const name of NATIVE_SPEEDUPS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(serverPkg.dependencies, name), false,
      `${name} must not be a direct dependency`,
    );
  }
  for (const [key, entry] of Object.entries(serverLock.packages)) {
    if (entry.optional === true || entry.dev === true) continue;
    for (const name of NATIVE_SPEEDUPS) {
      assert.ok(
        !(name in (entry.dependencies ?? {})),
        `${key || "the root package"} has ${name} as a dependency, ` +
        "which makes it mandatory in the production tree",
      );
      // A peer dependency only counts if it is not declared optional. ws
      // lists both of these as optional peers, which is the whole reason it
      // works without them.
      if (name in (entry.peerDependencies ?? {})) {
        assert.equal(
          entry.peerDependenciesMeta?.[name]?.optional, true,
          `${key || "the root package"} needs ${name} as a peer and does not mark it optional`,
        );
      }
    }
  }
});

test("the install command in the service unit omits dev and optional", () => {
  // The fix lives in a comment in a unit file, so it is exactly the sort of
  // thing that gets edited back. If somebody drops a flag, this says so.
  const unit = readFileSync(path.join(REPO, "deploy/floorfight.service"), "utf8");
  const match = /npm ci [^\n]*/.exec(unit);
  assert.ok(match, "the unit should document how to install");
  assert.match(match![0], /--omit=dev/);
  assert.match(match![0], /--omit=optional/);

  // And no .npmrc pretending to do the same job. An --omit on the command
  // line replaces the file's value instead of adding to it, so a file saying
  // omit=optional looks like protection and is none.
  let npmrc = "";
  try {
    npmrc = readFileSync(path.join(SERVER_DIR, ".npmrc"), "utf8");
  } catch {
    npmrc = "";
  }
  assert.doesNotMatch(
    npmrc, /^\s*omit/m,
    "an omit in .npmrc is overridden by any --omit flag: keep it on the command line",
  );
});

test("the lockfiles are the format this npm major writes", () => {
  // lockfileVersion 3 is npm 7 and later. A 1 or 2 here would mean somebody
  // regenerated with an old npm, and npm ci would quietly install a
  // different tree than the one that was tested.
  assert.equal(serverLock.lockfileVersion, 3);
  assert.equal(lock(path.join(REPO, "package-lock.json")).lockfileVersion, 3);
});
