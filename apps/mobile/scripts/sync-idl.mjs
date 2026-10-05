/**
 * Copy the Anchor IDL into the app.
 *
 * target/ is gitignored, so the app keeps its own copy of the IDL and this
 * script refreshes it. The IDL is a public artifact, not a secret, and the
 * app needs it in the bundle to build transactions without asking anyone
 * what a join instruction looks like.
 *
 * Run it after every `cargo build-sbf` plus `anchor idl build`. escrow.ts
 * checks the program address in the copy against the one this build expects
 * and refuses to start if they differ, so a stale copy fails loudly.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "../../../target/idl/arena.json");
const to = join(here, "../src/idl/arena.json");

const idl = JSON.parse(readFileSync(from, "utf8"));
if (!idl.address) throw new Error(`${from} has no program address`);

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied IDL for ${idl.address}`);
