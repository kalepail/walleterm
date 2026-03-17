import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SecretProvider {
  readonly scheme: string;
  resolve(ref: string): Promise<string>;
}

export interface SecretResolverOptions {
  opBin?: string;
  securityBin?: string;
  providers?: SecretProvider[];
}

export interface KeychainSecretRef {
  service: string;
  account: string;
  keychain?: string;
}

function canUseMacOSKeychain(options: SecretResolverOptions): boolean {
  return process.platform === "darwin" || options.securityBin !== undefined;
}

function normalizeScheme(value: string): string {
  return value.toLowerCase();
}

function refScheme(raw: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  return match ? normalizeScheme(match[1]!) : null;
}

function safeEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  for (const [key, val] of Object.entries(process.env)) {
    if ((key.startsWith("OP_") || key.startsWith("WALLETERM_")) && val) env[key] = val;
  }
  return env;
}

function execCommand(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(bin, args, {
    maxBuffer: 1024 * 1024,
    env: safeEnv(),
  });
}

function truncateErrorMessage(error: unknown, maxLen = 200): string {
  const msg = String(error);
  return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
}

export function looksLikeSecretRef(raw: string): boolean {
  return refScheme(raw) !== null;
}

export function parseKeychainSecretRef(raw: string): KeychainSecretRef {
  const scheme = refScheme(raw);
  if (scheme !== "keychain") {
    throw new Error(`Invalid keychain secret ref '${raw}'`);
  }

  const withoutScheme = raw.slice("keychain://".length);
  const [pathPart, queryPart = ""] = withoutScheme.split("?", 2);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    throw new Error(
      `Invalid keychain ref '${raw}'. Expected keychain://<service>/<account>[?keychain=<path>]`,
    );
  }

  const [serviceRaw, accountRaw] = segments;
  const query = new URLSearchParams(queryPart);
  const keychain = query.get("keychain")?.trim() || undefined;

  return {
    service: decodeURIComponent(serviceRaw!),
    account: decodeURIComponent(accountRaw!),
    keychain,
  };
}

export function buildKeychainSecretRef(
  service: string,
  account: string,
  keychain?: string,
): string {
  const base = `keychain://${encodeURIComponent(service)}/${encodeURIComponent(account)}`;
  if (!keychain) return base;
  return `${base}?keychain=${encodeURIComponent(keychain)}`;
}

export class OnePasswordSecretProvider implements SecretProvider {
  readonly scheme = "op";

  constructor(private readonly opBin: string = process.env.WALLETERM_OP_BIN ?? "op") {}

  async resolve(ref: string): Promise<string> {
    const withoutScheme = ref.slice("op://".length);
    const segments = withoutScheme.split("/").filter((s) => s.length > 0);
    if (segments.length !== 3) {
      throw new Error(
        `Invalid 1Password reference '${ref}': expected format op://<vault>/<item>/<field>`,
      );
    }

    let stdout: string;
    try {
      ({ stdout } = await execCommand(this.opBin, ["read", ref]));
    } catch (error) {
      throw new Error(
        `Failed resolving 1Password ref '${ref}' using '${this.opBin} read': ${truncateErrorMessage(error)}`,
      );
    }

    const value = stdout.trim();
    if (!value) {
      throw new Error(`1Password ref '${ref}' resolved to an empty value`);
    }

    return value;
  }
}

export class MacOSKeychainSecretProvider implements SecretProvider {
  readonly scheme = "keychain";

  constructor(
    private readonly securityBin: string = process.env.WALLETERM_SECURITY_BIN ?? "security",
  ) {}

  async resolve(ref: string): Promise<string> {
    const { service, account, keychain } = parseKeychainSecretRef(ref);
    const args = ["find-generic-password", "-a", account, "-s", service, "-w"];
    if (keychain) {
      args.push(keychain);
    }

    let stdout: string;
    try {
      ({ stdout } = await execCommand(this.securityBin, args));
    } catch (error) {
      throw new Error(
        `Failed resolving macOS keychain ref '${ref}' using '${this.securityBin} find-generic-password': ${truncateErrorMessage(error)}`,
      );
    }

    const value = stdout.trim();
    if (!value) {
      throw new Error(`macOS keychain ref '${ref}' resolved to an empty value`);
    }

    return value;
  }
}

function defaultProviders(options: SecretResolverOptions): SecretProvider[] {
  const providers: SecretProvider[] = [new OnePasswordSecretProvider(options.opBin)];
  if (canUseMacOSKeychain(options)) {
    providers.push(new MacOSKeychainSecretProvider(options.securityBin));
  }
  return providers;
}

export class SecretResolver {
  private readonly cache = new Map<string, string>();
  private readonly providersByScheme: Map<string, SecretProvider>;

  constructor(options?: string | SecretResolverOptions) {
    const normalizedOptions =
      typeof options === "string" ? ({ opBin: options } satisfies SecretResolverOptions) : options;
    const providers = normalizedOptions?.providers ?? defaultProviders(normalizedOptions ?? {});
    this.providersByScheme = new Map(
      providers.map((provider) => [normalizeScheme(provider.scheme), provider]),
    );
  }

  isSupportedRef(raw: string): boolean {
    const scheme = refScheme(raw);
    return scheme !== null && this.providersByScheme.has(scheme);
  }

  supportedSchemes(): string[] {
    return [...this.providersByScheme.keys()].sort();
  }

  clearCache(): void {
    this.cache.clear();
  }

  async resolve(ref: string): Promise<string> {
    if (this.cache.has(ref)) {
      return this.cache.get(ref)!;
    }

    const scheme = refScheme(ref);
    if (!scheme) {
      throw new Error(
        `Unsupported secret_ref '${ref}'. Expected a provider ref like ${this.supportedSchemes()
          .map((value) => `${value}://`)
          .join(" or ")}.`,
      );
    }

    const provider = this.providersByScheme.get(scheme);
    if (!provider) {
      throw new Error(
        `Unsupported secret_ref '${ref}'. Supported schemes: ${this.supportedSchemes()
          .map((value) => `${value}://`)
          .join(", ")}.`,
      );
    }

    const value = await provider.resolve(ref);
    this.cache.set(ref, value);
    return value;
  }
}
