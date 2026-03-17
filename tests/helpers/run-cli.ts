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
  const effectiveOverrides: NodeJS.ProcessEnv = {
    ...envOverrides,
    WALLETERM_THROW_ON_CLI_ERROR: envOverrides?.WALLETERM_THROW_ON_CLI_ERROR ?? "1",
  };
  const keys = Object.keys(effectiveOverrides);
  for (const key of keys) {
    previousEnv.set(key, process.env[key]);
    const value = effectiveOverrides[key];
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
  let caughtError: unknown;
  let exitCode = 0;

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
    exitCode = process.exitCode ?? 0;
  } catch (error) {
    caughtError = error;
    exitCode = process.exitCode ?? 0;
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
    process.exitCode = originalExitCode;
  }

  if (caughtError !== undefined) {
    if (caughtError instanceof Error) {
      const errorWithOutput = caughtError as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      errorWithOutput.stdout ??= stdout;
      errorWithOutput.stderr ??= stderr;
      errorWithOutput.exitCode ??= exitCode;
    }
    throw caughtError;
  }

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
