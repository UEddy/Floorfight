// Starting the real server as a child process, for the tests that want to go
// through a real socket rather than call a function.
//
// Not a *.test.ts, so the runner does not try to run it on its own.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Server {
  port: number;
  proc: ChildProcess;
  /** Everything it has said on stdout and stderr, for a failure message. */
  output: () => string;
}

/**
 * Start a server and wait until it is listening.
 *
 * The environment is built from scratch rather than inherited wholesale: a
 * stray ARENA_DEV or RESOLVER_KEYPAIR_PATH in the shell would change what is
 * being tested, and in the resolver's case would stop the server starting at
 * all.
 */
export async function startServer(env: Record<string, string> = {}): Promise<Server> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const full: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    LOG_DIR: path.join(SERVER_DIR, ".test-logs"),
    ...env,
  };
  delete full.HOST;
  if (!("ARENA_DEV" in env)) delete full.ARENA_DEV;
  if (!("NODE_ENV" in env)) delete full.NODE_ENV;
  for (const key of ["RPC_URL", "PROGRAM_ID", "RESOLVER_KEYPAIR_PATH"]) {
    if (!(key in env)) delete full[key];
  }

  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: full,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  const output = () => out;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start:\n${out}`)),
      60_000,
    );
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes(`listening on 127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}:\n${out}`)));
  });

  return { port, proc, output };
}
