import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { smartAccountKitDeployerKeypair } from "./wallet.js";

const execFileAsync = promisify(execFile);

export interface SetupOpOptions {
  opBin?: string;
  vault: string;
  item: string;
  network: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  overwriteExisting: boolean;
  createVault: boolean;
}

export interface SetupOpResult {
  vault: string;
  item: string;
  network: string;
  op_bin: string;
  created_vault: boolean;
  created_item: boolean;
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

export function defaultItemForNetwork(network: string): string {
  if (network === "mainnet") return "walleterm-mainnet";
  if (network === "testnet") return "walleterm-testnet";
  return `walleterm-${network}`;
}

function refFor(vault: string, item: string, field: string): string {
  return `op://${vault}/${item}/${field}`;
}

/* c8 ignore start */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
/* c8 ignore stop */

async function runOp(opBin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(opBin, args, {
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`'${opBin} ${args.join(" ")}' failed: ${errorMessage(err)}`);
  }
}

async function tryRunOp(opBin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(opBin, args, {
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
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
  if (network === "testnet") {
    return "https://channels.openzeppelin.com/testnet/gen";
  }
  if (network === "mainnet") {
    return "https://channels.openzeppelin.com/gen";
  }
  return null;
}

async function resolveChannelsApiKey(
  explicitApiKey: string | undefined,
  network: string,
): Promise<string> {
  if (explicitApiKey) {
    return explicitApiKey;
  }

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
  vault: string,
  item: string,
  includeDeployerSeed: boolean,
): string {
  const defaults = networkDefaults(network);
  const deployerLine = includeDeployerSeed
    ? `deployer_secret_ref = "${refFor(vault, item, "deployer_seed")}"\n`
    : "";
  return `[networks.${network}]
rpc_url = "${defaults.rpcUrl}"
channels_base_url = "${defaults.channelsBaseUrl}"
channels_api_key_ref = "${refFor(vault, item, "channels_api_key")}"
${deployerLine}

[[smart_accounts.<alias>.delegated_signers]]
name = "primary_delegated"
address = "<will-be-filled-from-output>"
secret_ref = "${refFor(vault, item, "delegated_seed")}"
enabled = true`;
}

export async function setupOnePasswordForWallet(opts: SetupOpOptions): Promise<SetupOpResult> {
  const opBin = opts.opBin ?? process.env.WALLETERM_OP_BIN ?? "op";

  await runOp(opBin, ["--version"]);
  await runOp(opBin, ["whoami"]);

  const vaultExists = await tryRunOp(opBin, ["vault", "get", opts.vault]);
  let createdVault = false;
  if (!vaultExists) {
    if (!opts.createVault) {
      throw new Error(
        `Vault '${opts.vault}' does not exist. Re-run without --no-create-vault to create it.`,
      );
    }
    await runOp(opBin, ["vault", "create", opts.vault]);
    createdVault = true;
  }

  const itemExists = await tryRunOp(opBin, ["item", "get", opts.item, "--vault", opts.vault]);
  if (itemExists && !opts.overwriteExisting) {
    throw new Error(
      `Item '${opts.item}' already exists in vault '${opts.vault}'. ` +
        "Re-run with --force to overwrite wallet fields.",
    );
  }

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

  const fieldArgs = [
    `delegated_seed[password]=${delegated.secret()}`,
    `channels_api_key[password]=${channelsApiKey}`,
  ];
  if (includeDeployerSeed) {
    fieldArgs.unshift(`deployer_seed[password]=${deployer.secret()}`);
  }

  if (itemExists) {
    await runOp(opBin, ["item", "edit", opts.item, "--vault", opts.vault, ...fieldArgs]);
  } else {
    await runOp(opBin, [
      "item",
      "create",
      "--vault",
      opts.vault,
      "--category",
      "password",
      "--title",
      opts.item,
      ...fieldArgs,
    ]);
  }

  return {
    vault: opts.vault,
    item: opts.item,
    network: opts.network,
    op_bin: opBin,
    created_vault: createdVault,
    created_item: !itemExists,
    deployer_seed_stored: includeDeployerSeed,
    deployer_public_key: deployer.publicKey(),
    delegated_public_key: delegated.publicKey(),
    refs: {
      deployer_seed_ref: includeDeployerSeed
        ? refFor(opts.vault, opts.item, "deployer_seed")
        : undefined,
      delegated_seed_ref: refFor(opts.vault, opts.item, "delegated_seed"),
      channels_api_key_ref: refFor(opts.vault, opts.item, "channels_api_key"),
    },
    config_snippet: makeConfigSnippet(opts.network, opts.vault, opts.item, includeDeployerSeed),
  };
}
