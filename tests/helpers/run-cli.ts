import { runCli } from "../../src/cli.js";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCliInProcess(
  args: string[],
  envOverrides?: NodeJS.ProcessEnv,
): Promise<CliRunResult> {
  const previousEnv = new Map<string, string | undefined>();
  const keys = Object.keys(envOverrides ?? {});
  for (const key of keys) {
    previousEnv.set(key, process.env[key]);
    const value = envOverrides?.[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  let stdout = "";
  let stderr = "";
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  process.exitCode = 0;

  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    await runCli(["bun", "walleterm", ...args]);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    for (const key of keys) {
      const prev = previousEnv.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;

  if (exitCode !== 0) {
    const err = new Error(stderr.trim() || `CLI exited with code ${exitCode}`) as Error & {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    err.stdout = stdout;
    err.stderr = stderr;
    err.exitCode = exitCode;
    throw err;
  }

  return { stdout, stderr, exitCode };
}
