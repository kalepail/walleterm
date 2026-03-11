import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { defaultItemForNetwork } from "./op-setup.js";
import { buildKeychainSecretRef } from "./secrets.js";
import { smartAccountKitDeployerKeypair } from "./wallet.js";

const execFileAsync = promisify(execFile);

export interface SetupKeychainOptions {
  securityBin?: string;
  service: string;
  network: string;
  keychain?: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  overwriteExisting: boolean;
}

export interface SetupKeychainResult {
  service: string;
  network: string;
  keychain?: string;
  security_bin: string;
  deployer_seed_stored: boolean;
  deployer_public_key: string;
  delegated_public_key: string;
  refs: {
    deployer_seed_ref?: string;
    delegated_seed_ref: string;
    channels_api_key_ref: string;
  };
  config_snippet: string;
}

type KeychainField = "channels_api_key" | "delegated_seed" | "deployer_seed";

function ensureMacOSAvailable(explicitSecurityBin: boolean): void {
  if (process.platform === "darwin" || explicitSecurityBin) {
    return;
  }
  throw new Error(
    "The macOS keychain backend is only available on macOS. For tests, provide an explicit security binary override.",
  );
}

function defaultSecurityBin(): string {
  return process.env.WALLETERM_SECURITY_BIN ?? "security";
}

function argsWithOptionalKeychain(args: string[], keychain?: string): string[] {
  if (!keychain) return args;
  return [...args, keychain];
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function runSecurity(
  securityBin: string,
  args: string[],
  keychain?: string,
): Promise<string> {
  const fullArgs = argsWithOptionalKeychain(args, keychain);
  try {
    const { stdout } = await execFileAsync(securityBin, fullArgs, {
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`'${securityBin} ${fullArgs.join(" ")}' failed: ${errorMessage(error)}`);
  }
}

async function hasGenericPassword(
  securityBin: string,
  service: string,
  account: string,
  keychain?: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      securityBin,
      argsWithOptionalKeychain(["find-generic-password", "-a", account, "-s", service], keychain),
      {
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function parseSeed(seed: string, label: string): Keypair {
  try {
    return Keypair.fromSecret(seed);
  } catch {
    throw new Error(`${label} must be a valid Stellar secret seed (S...)`);
  }
}

function inferChannelsGenUrl(network: string): string | null {
  if (network === "testnet") return "https://channels.openzeppelin.com/testnet/gen";
  if (network === "mainnet") return "https://channels.openzeppelin.com/gen";
  return null;
}

async function resolveChannelsApiKey(
  explicitApiKey: string | undefined,
  network: string,
): Promise<string> {
  if (explicitApiKey) return explicitApiKey;

  const genUrl = inferChannelsGenUrl(network);
  if (!genUrl) {
    throw new Error(
      `No default Channels API key generator for network '${network}'. Pass --channels-api-key.`,
    );
  }

  const response = await fetch(genUrl);
  if (!response.ok) {
    throw new Error(`Failed to generate channels API key (${response.status}) from ${genUrl}`);
  }

  const payload = (await response.json()) as { apiKey?: string };
  if (!payload.apiKey) {
    throw new Error(`Generator response from ${genUrl} did not include apiKey`);
  }
  return payload.apiKey;
}

function networkDefaults(network: string): { channelsBaseUrl: string; rpcUrl: string } {
  if (network === "testnet") {
    return {
      channelsBaseUrl: "https://channels.openzeppelin.com/testnet",
      rpcUrl: "https://soroban-rpc.testnet.stellar.gateway.fm",
    };
  }

  if (network === "mainnet") {
    return {
      channelsBaseUrl: "https://channels.openzeppelin.com",
      rpcUrl: "https://rpc.lightsail.network/",
    };
  }

  return {
    channelsBaseUrl: "<set-channels-base-url>",
    rpcUrl: "<set-rpc-url>",
  };
}

function makeConfigSnippet(
  network: string,
  service: string,
  keychain: string | undefined,
  includeDeployerSeed: boolean,
): string {
  const defaults = networkDefaults(network);
  const deployerLine = includeDeployerSeed
    ? `deployer_secret_ref = "${buildKeychainSecretRef(service, "deployer_seed", keychain)}"\n`
    : "";

  return `[networks.${network}]
rpc_url = "${defaults.rpcUrl}"
channels_base_url = "${defaults.channelsBaseUrl}"
channels_api_key_ref = "${buildKeychainSecretRef(service, "channels_api_key", keychain)}"
${deployerLine}

[[smart_accounts.<alias>.delegated_signers]]
name = "primary_delegated"
address = "<will-be-filled-from-output>"
secret_ref = "${buildKeychainSecretRef(service, "delegated_seed", keychain)}"
enabled = true`;
}

async function storeGenericPassword(
  securityBin: string,
  service: string,
  account: KeychainField,
  value: string,
  keychain: string | undefined,
  overwriteExisting: boolean,
): Promise<void> {
  const args = ["add-generic-password", "-a", account, "-s", service, "-w", value];
  if (overwriteExisting) {
    args.push("-U");
  }
  await runSecurity(securityBin, args, keychain);
}

export function defaultServiceForNetwork(network: string): string {
  return defaultItemForNetwork(network);
}

export async function setupMacOSKeychainForWallet(
  opts: SetupKeychainOptions,
): Promise<SetupKeychainResult> {
  ensureMacOSAvailable(
    opts.securityBin !== undefined || process.env.WALLETERM_SECURITY_BIN !== undefined,
  );
  const securityBin = opts.securityBin ?? defaultSecurityBin();
  await runSecurity(securityBin, ["help"]);

  const includeDeployerSeed = opts.includeDeployerSeed ?? opts.deployerSeed !== undefined;
  const deployer = includeDeployerSeed
    ? opts.deployerSeed
      ? parseSeed(opts.deployerSeed, "deployer seed")
      : Keypair.random()
    : smartAccountKitDeployerKeypair();
  const delegated = opts.delegatedSeed
    ? parseSeed(opts.delegatedSeed, "delegated seed")
    : Keypair.random();
  const channelsApiKey = await resolveChannelsApiKey(opts.channelsApiKey, opts.network);

  const plannedFields: Array<{ account: KeychainField; value: string }> = [
    { account: "delegated_seed", value: delegated.secret() },
    { account: "channels_api_key", value: channelsApiKey },
  ];
  if (includeDeployerSeed) {
    plannedFields.unshift({ account: "deployer_seed", value: deployer.secret() });
  }

  const existingAccounts: string[] = [];
  for (const field of plannedFields) {
    if (await hasGenericPassword(securityBin, opts.service, field.account, opts.keychain)) {
      existingAccounts.push(field.account);
    }
  }

  if (existingAccounts.length > 0 && !opts.overwriteExisting) {
    throw new Error(
      `Keychain service '${opts.service}' already contains ${existingAccounts.join(", ")}. Re-run with --force to overwrite those entries.`,
    );
  }

  for (const field of plannedFields) {
    await storeGenericPassword(
      securityBin,
      opts.service,
      field.account,
      field.value,
      opts.keychain,
      existingAccounts.includes(field.account),
    );
  }

  return {
    service: opts.service,
    network: opts.network,
    keychain: opts.keychain,
    security_bin: securityBin,
    deployer_seed_stored: includeDeployerSeed,
    deployer_public_key: deployer.publicKey(),
    delegated_public_key: delegated.publicKey(),
    refs: {
      deployer_seed_ref: includeDeployerSeed
        ? buildKeychainSecretRef(opts.service, "deployer_seed", opts.keychain)
        : undefined,
      delegated_seed_ref: buildKeychainSecretRef(opts.service, "delegated_seed", opts.keychain),
      channels_api_key_ref: buildKeychainSecretRef(opts.service, "channels_api_key", opts.keychain),
    },
    config_snippet: makeConfigSnippet(
      opts.network,
      opts.service,
      opts.keychain,
      includeDeployerSeed,
    ),
  };
}
