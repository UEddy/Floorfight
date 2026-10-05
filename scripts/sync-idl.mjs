/**
 * Copy the Anchor IDL out of target/ into the repo.
 *
 * target/ is gitignored, so idl/arena.json is the committed copy and the one
 * thing allowed to know the program's discriminators. The server reads it
 * directly; the mobile app copies it again into its own source tree because
 * Metro will not reach outside the project.
 *
 * Run after every program build:
 *   cd programs/arena && cargo build-sbf --tools-version v1.57 && cd ../..
 *   anchor idl build -p arena -o target/idl/arena.json
 *   npm run idl:sync
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "target/idl/arena.json");
const to = join(root, "idl/arena.json");

const idl = JSON.parse(readFileSync(from, "utf8"));
if (!idl.address) throw new Error(`${from} has no program address`);
for (const name of ["settle", "join_match", "claim"]) {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix || ix.discriminator?.length !== 8) {
    throw new Error(`${from} has no usable ${name} instruction`);
  }
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied IDL for ${idl.address} to idl/arena.json`);
