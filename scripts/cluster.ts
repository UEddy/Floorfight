/**
 * Shared by init-config.ts and show-config.ts: argument parsing, the cluster
 * choice, and the program's config account.
 *
 * Devnet unless told otherwise, and mainnet only with --mainnet. A wrong RPC
 * URL is easy to paste, so the cluster is checked by asking the node for its
 * genesis hash rather than by reading the URL: a devnet run that is actually
 * talking to mainnet is refused even if the URL looks harmless.
 */
import { BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const IDL = JSON.parse(
  readFileSync(join(__dirname, "..", "idl", "arena.json"), "utf8"),
) as Idl & { address: string };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const instructions = new BorshInstructionCoder(IDL);
export const accountsCoder = new BorshAccountsCoder(IDL);

export const [CONFIG_PDA] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

/** Genesis hashes of the public clusters. */
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/** The same bounds the program checks in validate_config. */
export const MIN_SETTLE_WINDOW = 120;
export const MAX_SETTLE_WINDOW = 86_400;

export type Args = Map<string, string | true>;

/**
 * `--name value` and `--flag`. Unknown names are refused, so a typo such as
 * `--min_stake` fails instead of silently taking a default.
 */
export function parseArgs(argv: string[], valued: string[], flags: string[]): Args {
  const out: Args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (flags.includes(name)) {
      out.set(name, true);
    } else if (valued.includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      out.set(name, v);
    } else {
      throw new Error(`unknown option --${name}`);
    }
  }
  return out;
}

export function str(args: Args, name: string): string | undefined {
  const v = args.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * Connect, and refuse the wrong cluster.
 *
 * Without --mainnet the node must be devnet (or a local validator, whose
 * genesis is its own). With --mainnet it must be mainnet: a flag that says
 * mainnet while the URL points at devnet is a mistake, not a dry run.
 */
export async function connect(args: Args): Promise<{ connection: Connection; cluster: string }> {
  const mainnet = args.get("mainnet") === true;
  const url = str(args, "rpc") ?? (mainnet ? MAINNET_RPC : DEVNET_RPC);
  const connection = new Connection(url, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS && !mainnet) {
    throw new Error(
      `${url} is mainnet. This script defaults to devnet and refuses mainnet ` +
      "unless --mainnet is passed.",
    );
  }
  if (mainnet && genesis !== MAINNET_GENESIS) {
    throw new Error(`--mainnet was passed but ${url} is not mainnet (genesis ${genesis})`);
  }
  const cluster = genesis === MAINNET_GENESIS ? "mainnet"
    : genesis === DEVNET_GENESIS ? "devnet"
      : `custom cluster ${genesis}`;
  return { connection, cluster };
}

export interface ConfigAccount {
  admin: PublicKey;
  resolver: PublicKey;
  minStake: bigint;
  maxStake: bigint;
  settleWindow: number;
  paused: boolean;
}

export async function readConfig(connection: Connection): Promise<ConfigAccount | null> {
  const info = await connection.getAccountInfo(CONFIG_PDA);
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error(`${CONFIG_PDA.toBase58()} is not owned by the program`);
  }
  const c = accountsCoder.decode("Config", info.data) as Record<string, unknown>;
  const get = (snake: string, camel: string) => c[snake] ?? c[camel];
  return {
    admin: new PublicKey(get("admin", "admin") as PublicKey),
    resolver: new PublicKey(get("resolver", "resolver") as PublicKey),
    minStake: BigInt(String(get("min_stake", "minStake"))),
    maxStake: BigInt(String(get("max_stake", "maxStake"))),
    settleWindow: Number(String(get("settle_window", "settleWindow"))),
    paused: Boolean(get("paused", "paused")),
  };
}

export function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function printConfig(c: ConfigAccount): void {
  console.log(`admin          ${c.admin.toBase58()}`);
  console.log(`resolver       ${c.resolver.toBase58()}`);
  console.log(`min stake      ${c.minStake} lamports (${sol(c.minStake)} SOL)`);
  console.log(`max stake      ${c.maxStake} lamports (${sol(c.maxStake)} SOL)`);
  console.log(`settle window  ${c.settleWindow} s`);
  console.log(`paused         ${c.paused}`);
}

/** Run main, print an error without a stack for the expected failures. */
export function run(main: () => Promise<void>): void {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
