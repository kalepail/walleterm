#!/usr/bin/env bun
import { Command } from "commander";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  canSignInput,
  computeExpirationLedger,
  inspectInput,
  listSignerConfig,
  loadRuntimeSigners,
  parseInputFile,
  resolveAccountForCommand,
  signInput,
  verifySignerSecrets,
  writeOutput,
} from "./core.js";
import { loadConfig, resolveNetwork } from "./config.js";
import { SecretResolver } from "./secrets.js";
import { defaultItemForNetwork, setupOnePasswordForWallet } from "./op-setup.js";
import { submitTxXdrViaRpc, submitViaChannels, type SubmitNetworkOverrides } from "./submit.js";
import {
  buildSignerMutationBundle,
  createWalletDeployTx,
  deriveSaltHexFromRawString,
  discoverContractsByAddress,
  listContractSigners,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
  resolveIndexerUrl,
  smartAccountKitDeployerKeypair,
} from "./wallet.js";

interface BaseOpts {
  config: string;
  network?: string;
  account?: string;
}

interface InputOpts extends BaseOpts {
  in: string;
}

interface SignOpts extends InputOpts {
  out: string;
  ttlSeconds?: string;
  latestLedger?: string;
}

interface WalletLookupOpts extends BaseOpts {
  indexerUrl?: string;
  address?: string;
  contractId?: string;
}

interface WalletMutationOpts extends BaseOpts {
  out: string;
  contextRuleId: string;
  ttlSeconds?: string;
  latestLedger?: string;
  delegatedAddress?: string;
  verifierContractId?: string;
  publicKeyHex?: string;
}

interface WalletCreateOpts extends BaseOpts {
  out: string;
  deployerSecretRef?: string;
  kitRawId?: string;
  wasmHash: string;
  delegatedAddress: string[];
  externalEd25519: string[];
  saltHex?: string;
  sequence?: string;
  fee?: string;
  skipPrepare?: boolean;
  submit?: boolean;
  submitMode?: "channels" | "rpc";
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}

interface SubmitOpts extends InputOpts {
  mode: "channels" | "rpc";
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}

interface SetupOpOpts {
  vault: string;
  item?: string;
  network: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  force?: boolean;
  createVault: boolean;
  json?: boolean;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value '${value}'`);
  }
  return parsed;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requireAccountAlias(alias: string | undefined): string {
  if (!alias) {
    throw new Error("Pass --account <alias>");
  }
  return alias;
}

function requireNonNegativeInt(value: number | undefined, label: string): number {
  if (value === undefined || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function getSubmitOverrides(opts: {
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}): SubmitNetworkOverrides {
  return {
    channelsBaseUrl: opts.channelsBaseUrl,
    channelsApiKey: opts.channelsApiKey,
    channelsApiKeyRef: opts.channelsApiKeyRef,
    pluginId: opts.pluginId,
  };
}

async function runSignerMutation(
  opts: WalletMutationOpts,
  functionName: "add_signer" | "remove_signer",
  signerScVal: xdr.ScVal,
  signerDescriptor: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig(opts.config);
  const { name: networkName, config: network } = resolveNetwork(config, opts.network);
  const accountAlias = requireAccountAlias(opts.account);
  const account = config.smart_accounts[accountAlias];
  if (!account) throw new Error(`Smart account '${accountAlias}' not found`);
  if (account.network !== networkName) {
    throw new Error(
      `Smart account '${accountAlias}' belongs to network '${account.network}', not '${networkName}'`,
    );
  }

  const resolver = new SecretResolver();
  const accountRef = { alias: accountAlias, account };
  const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);

  const ttlSeconds = parseOptionalInt(opts.ttlSeconds) ?? config.app.default_ttl_seconds ?? 30;
  const ledgerSeconds = config.app.assumed_ledger_time_seconds ?? 6;
  const latestLedger = parseOptionalInt(opts.latestLedger);
  const expirationLedger = await computeExpirationLedger(
    network,
    ttlSeconds,
    ledgerSeconds,
    latestLedger,
  );

  const contextRuleId = requireNonNegativeInt(
    parseOptionalInt(opts.contextRuleId),
    "context-rule-id",
  );

  const parsed = buildSignerMutationBundle(
    account.contract_id,
    functionName,
    contextRuleId,
    signerScVal,
    expirationLedger,
  );

  const { output, report } = signInput(parsed, {
    config,
    networkName,
    network,
    accountRef,
    runtimeSigners,
    expirationLedger,
  });

  writeOutput(opts.out, output);
  process.stdout.write(
    `${JSON.stringify({
      operation: functionName,
      contract_id: account.contract_id,
      context_rule_id: contextRuleId,
      target_signer: signerDescriptor,
      ...report,
    })}\n`,
  );
}

export const __testOnly = {
  parseOptionalInt,
  requireAccountAlias,
  requireNonNegativeInt,
  getSubmitOverrides,
};

const program = new Command();
program
  .name("walleterm")
  .description("CLI signer for Stellar/OZ smart-account flows")
  .showHelpAfterError();

program
  .command("inspect")
  .requiredOption("--in <path>", "input file (xdr or json)")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .action(async (opts: InputOpts) => {
    const parsed = parseInputFile(opts.in);
    const data = inspectInput(parsed);
    process.stdout.write(`${JSON.stringify(data)}\n`);
  });

program
  .command("can-sign")
  .requiredOption("--in <path>", "input file (xdr or json)")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--account <alias>", "smart account alias")
  .action(async (opts: InputOpts) => {
    const config = loadConfig(opts.config);
    const parsed = parseInputFile(opts.in);

    const { name: networkName, config: network } = resolveNetwork(config, opts.network);
    const accountRef = resolveAccountForCommand(config, networkName, opts.account, parsed);

    const resolver = new SecretResolver();
    const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);

    const result = canSignInput(parsed, {
      config,
      networkName,
      network,
      accountRef,
      runtimeSigners,
      expirationLedger: 0,
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

program
  .command("sign")
  .requiredOption("--in <path>", "input file (xdr or json)")
  .requiredOption("--out <path>", "output file")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--account <alias>", "smart account alias")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .action(async (opts: SignOpts) => {
    const config = loadConfig(opts.config);
    const parsed = parseInputFile(opts.in);

    const { name: networkName, config: network } = resolveNetwork(config, opts.network);
    const accountRef = resolveAccountForCommand(config, networkName, opts.account, parsed);

    if (!accountRef) {
      throw new Error(
        "No smart account selected. Pass --account <alias> or ensure there is exactly one account on the selected network.",
      );
    }

    const resolver = new SecretResolver();
    const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);

    const ttlSeconds = parseOptionalInt(opts.ttlSeconds) ?? config.app.default_ttl_seconds ?? 30;
    const ledgerSeconds = config.app.assumed_ledger_time_seconds ?? 6;
    const latestLedger = parseOptionalInt(opts.latestLedger);

    const expirationLedger = await computeExpirationLedger(
      network,
      ttlSeconds,
      ledgerSeconds,
      latestLedger,
    );

    const { output, report } = signInput(parsed, {
      config,
      networkName,
      network,
      accountRef,
      runtimeSigners,
      expirationLedger,
    });

    writeOutput(opts.out, output);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  });

program
  .command("submit")
  .requiredOption("--in <path>", "signed tx xdr or {func,auth} bundle json")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--mode <mode>", "channels|rpc", "channels")
  .option("--channels-base-url <url>", "override channels base URL")
  .option("--channels-api-key <key>", "direct channels API key")
  .option("--channels-api-key-ref <ref>", "channels API key or op:// ref")
  .option("--plugin-id <id>", "channels plugin id (self-hosted relayer mode)")
  .action(async (opts: SubmitOpts) => {
    const config = loadConfig(opts.config);
    const parsed = parseInputFile(opts.in);
    const { config: network } = resolveNetwork(config, opts.network);

    const mode = opts.mode;
    if (mode === "rpc") {
      if (parsed.kind !== "tx") {
        throw new Error("RPC submission currently supports signed tx envelope input only.");
      }
      const rpcResult = await submitTxXdrViaRpc(parsed.envelope.toXDR("base64"), network);
      process.stdout.write(
        `${JSON.stringify({
          mode: "rpc",
          request_kind: "tx",
          ...rpcResult,
        })}\n`,
      );
      return;
    }

    const resolver = new SecretResolver();
    const result = await submitViaChannels(parsed, network, resolver, getSubmitOverrides(opts));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

const setup = program.command("setup").description("environment and secret setup");

setup
  .command("op")
  .description("bootstrap 1Password secrets for wallet creation/signing")
  .option("--vault <name>", "1Password vault name", "Private")
  .option(
    "--item <name>",
    "1Password item name (default: walleterm-testnet or walleterm-mainnet by network)",
  )
  .option("--network <name>", "network context (used for defaults)", "testnet")
  .option("--deployer-seed <seed>", "existing deployer S... seed (if provided, it will be stored)")
  .option("--delegated-seed <seed>", "existing delegated S... seed (defaults to generated)")
  .option(
    "--channels-api-key <key>",
    "channels API key (defaults to auto-generated on testnet/mainnet)",
  )
  .option(
    "--include-deployer-seed",
    "store deployer seed in 1Password (default uses smart-account-kit deterministic deployer)",
    false,
  )
  .option("--force", "overwrite existing item fields", false)
  .option("--no-create-vault", "fail instead of creating missing vault")
  .option("--json", "print only json output", false)
  .action(async (opts: SetupOpOpts) => {
    const networkName = opts.network;
    const result = await setupOnePasswordForWallet({
      vault: opts.vault,
      item: opts.item ?? defaultItemForNetwork(networkName),
      network: networkName,
      deployerSeed: opts.deployerSeed,
      delegatedSeed: opts.delegatedSeed,
      channelsApiKey: opts.channelsApiKey,
      includeDeployerSeed: opts.includeDeployerSeed ? true : undefined,
      overwriteExisting: Boolean(opts.force),
      createVault: opts.createVault,
    });

    if (!result.created_item) {
      const overwrittenFields = [
        ...(result.deployer_seed_stored ? ["deployer_seed"] : []),
        "delegated_seed",
        "channels_api_key",
      ].join(", ");
      process.stderr.write(
        `warning: item '${result.item}' already exists in vault '${result.vault}'. ` +
          `Overwriting fields: ${overwrittenFields}.\n`,
      );
    }

    if (!opts.json) {
      process.stderr.write("1Password wallet bootstrap complete.\n");
      process.stderr.write(
        `deployer_public_key=${result.deployer_public_key}\n` +
          `delegated_public_key=${result.delegated_public_key}\n`,
      );
      process.stderr.write(
        `refs: ${result.refs.deployer_seed_ref ?? "(not stored)"}, ${result.refs.delegated_seed_ref}, ${result.refs.channels_api_key_ref}\n`,
      );
      process.stderr.write("config snippet:\n");
      process.stderr.write(`${result.config_snippet}\n`);
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

const keys = program.command("keys").description("key management");

keys
  .command("list")
  .requiredOption("--account <alias>", "smart account alias")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .action(async (opts: BaseOpts) => {
    const config = loadConfig(opts.config);
    const account = config.smart_accounts[opts.account!];
    if (!account) throw new Error(`Smart account '${opts.account}' not found`);

    const result = listSignerConfig({ alias: opts.account!, account });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

keys
  .command("verify")
  .requiredOption("--account <alias>", "smart account alias")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .action(async (opts: BaseOpts) => {
    const config = loadConfig(opts.config);
    const account = config.smart_accounts[opts.account!];
    if (!account) throw new Error(`Smart account '${opts.account}' not found`);

    const resolver = new SecretResolver();
    const result = await verifySignerSecrets({ alias: opts.account!, account }, resolver);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

keys
  .command("create")
  .description("generate a new Stellar keypair")
  .action(() => {
    const keypair = Keypair.random();
    process.stdout.write(
      `${JSON.stringify({
        secret_seed: keypair.secret(),
        public_key: keypair.publicKey(),
        public_key_hex: Buffer.from(keypair.rawPublicKey()).toString("hex"),
      })}\n`,
    );
  });

const wallet = program.command("wallet").description("smart wallet management");

wallet
  .command("discover")
  .requiredOption("--address <stellar-address>", "G... or C... signer address")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--indexer-url <url>", "override indexer base URL")
  .action(async (opts: WalletLookupOpts) => {
    const config = loadConfig(opts.config);
    const { config: network } = resolveNetwork(config, opts.network);
    const indexerUrl = resolveIndexerUrl(network, opts.indexerUrl);
    const result = await discoverContractsByAddress(indexerUrl, opts.address!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

wallet
  .command("list-signers")
  .requiredOption("--contract-id <contract-id>", "smart account contract C-address")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--indexer-url <url>", "override indexer base URL")
  .action(async (opts: WalletLookupOpts) => {
    const config = loadConfig(opts.config);
    const { config: network } = resolveNetwork(config, opts.network);
    const indexerUrl = resolveIndexerUrl(network, opts.indexerUrl);
    const result = await listContractSigners(indexerUrl, opts.contractId!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

wallet
  .command("reconcile")
  .requiredOption("--account <alias>", "smart account alias")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--indexer-url <url>", "override indexer base URL")
  .action(async (opts: WalletLookupOpts) => {
    const config = loadConfig(opts.config);
    const { name: networkName, config: network } = resolveNetwork(config, opts.network);
    const accountAlias = requireAccountAlias(opts.account);
    const account = config.smart_accounts[accountAlias];
    if (!account) throw new Error(`Smart account '${accountAlias}' not found`);
    if (account.network !== networkName) {
      throw new Error(
        `Smart account '${accountAlias}' belongs to network '${account.network}', not '${networkName}'`,
      );
    }

    const indexerUrl = resolveIndexerUrl(network, opts.indexerUrl);
    const onchain = await listContractSigners(indexerUrl, account.contract_id);
    const local = listSignerConfig({ alias: accountAlias, account });

    const localKeys = new Set<string>();
    for (const row of local.delegated) {
      localKeys.add(`Delegated|${row.address}`);
    }
    for (const row of local.external) {
      localKeys.add(`External|${row.verifier_contract_id}|${row.public_key_hex.toLowerCase()}`);
    }

    const onchainKeys = new Set<string>();
    for (const row of onchain.signers) {
      if (row.signer_type === "Delegated" && row.signer_address) {
        onchainKeys.add(`Delegated|${row.signer_address}`);
      } else if (row.signer_type === "External" && row.signer_address && row.credential_id) {
        onchainKeys.add(`External|${row.signer_address}|${row.credential_id.toLowerCase()}`);
      }
    }

    const onlyLocal = [...localKeys].filter((key) => !onchainKeys.has(key));
    const onlyOnchain = [...onchainKeys].filter((key) => !localKeys.has(key));

    process.stdout.write(
      `${JSON.stringify({
        account: accountAlias,
        contract_id: account.contract_id,
        matched: [...localKeys].filter((key) => onchainKeys.has(key)),
        only_local: onlyLocal,
        only_onchain: onlyOnchain,
        note: "External signer key matching compares indexer credential_id with config public_key_hex.",
      })}\n`,
    );
  });

wallet
  .command("add-delegated-signer")
  .requiredOption("--account <alias>", "smart account alias")
  .requiredOption("--context-rule-id <n>", "context rule id")
  .requiredOption("--delegated-address <g-address>", "G-address signer")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutation(opts, "add_signer", makeDelegatedSignerScVal(opts.delegatedAddress!), {
      type: "Delegated",
      address: opts.delegatedAddress,
    });
  });

wallet
  .command("remove-delegated-signer")
  .requiredOption("--account <alias>", "smart account alias")
  .requiredOption("--context-rule-id <n>", "context rule id")
  .requiredOption("--delegated-address <g-address>", "G-address signer")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutation(
      opts,
      "remove_signer",
      makeDelegatedSignerScVal(opts.delegatedAddress!),
      { type: "Delegated", address: opts.delegatedAddress },
    );
  });

wallet
  .command("add-external-ed25519-signer")
  .requiredOption("--account <alias>", "smart account alias")
  .requiredOption("--context-rule-id <n>", "context rule id")
  .requiredOption("--verifier-contract-id <contract-id>", "verifier contract C-address")
  .requiredOption("--public-key-hex <hex>", "32-byte ed25519 public key hex")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutation(
      opts,
      "add_signer",
      makeExternalSignerScVal(opts.verifierContractId!, opts.publicKeyHex!),
      {
        type: "External",
        verifier_contract_id: opts.verifierContractId,
        public_key_hex: opts.publicKeyHex,
      },
    );
  });

wallet
  .command("remove-external-ed25519-signer")
  .requiredOption("--account <alias>", "smart account alias")
  .requiredOption("--context-rule-id <n>", "context rule id")
  .requiredOption("--verifier-contract-id <contract-id>", "verifier contract C-address")
  .requiredOption("--public-key-hex <hex>", "32-byte ed25519 public key hex")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutation(
      opts,
      "remove_signer",
      makeExternalSignerScVal(opts.verifierContractId!, opts.publicKeyHex!),
      {
        type: "External",
        verifier_contract_id: opts.verifierContractId,
        public_key_hex: opts.publicKeyHex,
      },
    );
  });

wallet
  .command("create")
  .option(
    "--deployer-secret-ref <op-ref>",
    "override deployer seed (default uses smart-account-kit deterministic deployer)",
  )
  .option(
    "--kit-raw-id <value>",
    "derive deployer+salt using smart-account-kit deterministic scheme from raw string",
  )
  .requiredOption("--wasm-hash <hex>", "smart account wasm hash (32-byte hex)")
  .requiredOption("--out <path>", "output signed transaction xdr path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--delegated-address <g-address>", "initial delegated signer", collectValues, [])
  .option(
    "--external-ed25519 <verifier:pubkeyhex>",
    "initial external ed25519 signer tuple",
    collectValues,
    [],
  )
  .option("--salt-hex <hex>", "32-byte salt hex (defaults to random)")
  .option("--sequence <n>", "override source account sequence")
  .option("--fee <stroops>", "transaction fee stroops (default 0; prepare sets resource fee)")
  .option("--skip-prepare", "skip rpc prepareTransaction", false)
  .option("--submit", "submit after creating signed tx xdr", false)
  .option("--submit-mode <mode>", "channels|rpc")
  .option("--channels-base-url <url>", "override channels base URL")
  .option("--channels-api-key <key>", "direct channels API key")
  .option("--channels-api-key-ref <ref>", "channels API key or op:// ref")
  .option("--plugin-id <id>", "channels plugin id (self-hosted relayer mode)")
  .action(async (opts: WalletCreateOpts) => {
    const config = loadConfig(opts.config);
    const { config: network } = resolveNetwork(config, opts.network);
    const resolver = new SecretResolver();

    let deployer: Keypair;
    let createSaltHex = opts.saltHex;
    const usingKitDeterministic = typeof opts.kitRawId === "string";
    const effectiveDeployerRef = opts.deployerSecretRef ?? network.deployer_secret_ref;
    const usingCustomDeployer = Boolean(effectiveDeployerRef);

    if (usingKitDeterministic) {
      if (opts.deployerSecretRef) {
        throw new Error("Do not pass --deployer-secret-ref with --kit-raw-id.");
      }
      if (opts.saltHex) {
        throw new Error("Do not pass --salt-hex with --kit-raw-id (salt is derived).");
      }
      deployer = smartAccountKitDeployerKeypair();
      createSaltHex = deriveSaltHexFromRawString(opts.kitRawId!);
    } else if (usingCustomDeployer) {
      const deployerSeed = await resolver.resolve(effectiveDeployerRef!);
      try {
        deployer = Keypair.fromSecret(deployerSeed);
      } catch {
        throw new Error("deployer secret must resolve to a valid Stellar secret seed (S...)");
      }
    } else {
      deployer = smartAccountKitDeployerKeypair();
    }

    const signers: xdr.ScVal[] = [];
    for (const delegated of opts.delegatedAddress) {
      signers.push(makeDelegatedSignerScVal(delegated));
    }

    for (const row of opts.externalEd25519) {
      const separator = row.indexOf(":");
      if (separator < 0) {
        throw new Error(
          `Invalid --external-ed25519 value '${row}'. Expected verifierContractId:publicKeyHex`,
        );
      }
      const verifier = row.slice(0, separator);
      const publicKeyHex = row.slice(separator + 1);
      signers.push(makeExternalSignerScVal(verifier, publicKeyHex));
    }

    const { contractId, txXdr, saltHex } = await createWalletDeployTx({
      network,
      deployer,
      wasmHashHex: opts.wasmHash,
      signers,
      saltHex: createSaltHex,
      sequenceOverride: opts.sequence,
      fee: opts.fee,
      skipPrepare: Boolean(opts.skipPrepare),
    });

    writeOutput(opts.out, txXdr);

    let submission: unknown;
    if (opts.submit) {
      const mode = opts.submitMode ?? "channels";
      if (mode === "rpc") {
        const rpcResult = await submitTxXdrViaRpc(txXdr, network);
        submission = {
          mode: "rpc",
          request_kind: "tx",
          ...rpcResult,
        };
      } else {
        const parsed = parseInputFile(opts.out);
        submission = await submitViaChannels(parsed, network, resolver, getSubmitOverrides(opts));
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        contract_id: contractId,
        deployer_public_key: deployer.publicKey(),
        salt_hex: saltHex,
        deterministic_mode: usingKitDeterministic
          ? "smart-account-kit"
          : usingCustomDeployer
            ? "custom"
            : "smart-account-kit-deployer",
        deterministic_input: usingKitDeterministic ? opts.kitRawId : undefined,
        signers_count: signers.length,
        prepared: !opts.skipPrepare,
        submitted: Boolean(opts.submit),
        submission,
      })}\n`,
    );
  });

export async function runCli(argv: string[]): Promise<void> {
  await program.parseAsync(argv).catch((error: unknown) => {
    /* c8 ignore next */
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

/* c8 ignore start */
/* v8 ignore start */
if (import.meta.main) {
  await runCli(process.argv);
}
/* v8 ignore stop */
/* c8 ignore stop */
