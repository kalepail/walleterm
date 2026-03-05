import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class SecretResolver {
  private readonly cache = new Map<string, string>();
  private readonly opBin: string;

  constructor(opBin?: string) {
    this.opBin = opBin ?? process.env.WALLETERM_OP_BIN ?? "op";
  }

  async resolve(ref: string): Promise<string> {
    if (this.cache.has(ref)) {
      return this.cache.get(ref)!;
    }

    if (!ref.startsWith("op://")) {
      throw new Error(`Unsupported secret_ref '${ref}'. Only op:// references are supported.`);
    }

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.opBin, ["read", ref], {
        maxBuffer: 1024 * 1024,
        env: process.env,
      }));
    } catch (error) {
      throw new Error(
        `Failed resolving 1Password ref '${ref}' using '${this.opBin} read': ${String(error)}`,
      );
    }

    const value = stdout.trim();
    if (!value) {
      throw new Error(`1Password ref '${ref}' resolved to an empty value`);
    }

    this.cache.set(ref, value);
    return value;
  }
}
