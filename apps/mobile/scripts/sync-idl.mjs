/**
 * Copy the Anchor IDL into the app.
 *
 * Metro will not reach outside the project directory, so the app needs its
 * own copy. It comes from idl/arena.json at the repo root, which is the
 * committed one; run `npm run idl:sync` there first after a program build.
 *
 * The IDL is a public artifact, not a secret, and the app needs it in the
 * bundle to build transactions without asking anyone what a join instruction
 * looks like. escrow.ts checks the program address in the copy against the
 * one this build expects and refuses to start if they differ, so a stale copy
 * fails loudly.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "../../../idl/arena.json");
const to = join(here, "../src/idl/arena.json");

const idl = JSON.parse(readFileSync(from, "utf8"));
if (!idl.address) throw new Error(`${from} has no program address`);

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied IDL for ${idl.address}`);
