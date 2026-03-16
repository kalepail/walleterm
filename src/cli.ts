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
  writeOutput,
} from "./core.js";
import { loadConfig, resolveNetwork } from "./config.js";
import {
  createWalletermSigner,
  createX402HttpHandler,
  executeX402Request,
  passphraseToX402Network,
} from "./x402.js";
import { defaultServiceForNetwork, setupMacOSKeychainForWallet } from "./keychain-setup.js";
import { SecretResolver } from "./secrets.js";
import { defaultItemForNetwork, setupOnePasswordForWallet } from "./op-setup.js";
import { submitTxXdrViaRpc, submitViaChannels, type SubmitNetworkOverrides } from "./submit.js";
import {
  buildSignerMutationBundle,
  createWalletDeployTx,
  discoverContractsByCredentialId,
  deriveSaltHexFromRawString,
  discoverContractsByAddress,
  type IndexerContractSummary,
  listContractSigners,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
  resolveIndexerUrl,
  smartAccountKitDeployerKeypair,
} from "./wallet.js";
import { writeFileSync } from "node:fs";

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
  secretRef?: string;
}

interface WalletMutationOpts extends BaseOpts {
  account: string;
  out: string;
  contextRuleId: string;
  ttlSeconds?: string;
  latestLedger?: string;
  delegatedAddress?: string;
  secretRef?: string;
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

interface PayOpts {
  config: string;
  network?: string;
  secretRef?: string;
  method: string;
  header: string[];
  data?: string;
  format: string;
  out?: string;
  dryRun: boolean;
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

interface SetupKeychainOpts {
  service?: string;
  network: string;
  keychain?: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  force?: boolean;
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

function requireNonNegativeInt(value: number | undefined, label: string): number {
  if (value === undefined || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function dedupeContractsById(contracts: IndexerContractSummary[]): IndexerContractSummary[] {
  const byId = new Map<string, IndexerContractSummary>();
  for (const contract of contracts) {
    byId.set(contract.contract_id, contract);
  }
  return [...byId.values()];
}

function credentialIdFromKeypair(keypair: Keypair): string {
  return Buffer.from(keypair.rawPublicKey()).toString("hex");
}

function buildKeypairJson(keypair: Keypair): Record<string, string> {
  return {
    secret_seed: keypair.secret(),
    public_key: keypair.publicKey(),
    public_key_hex: credentialIdFromKeypair(keypair),
  };
}

async function enrichContractsWithOnchainSigners(
  indexerUrl: string,
  contracts: Array<
    IndexerContractSummary & {
      lookup_types?: string[];
    }
  >,
): Promise<
  Array<IndexerContractSummary & { lookup_types?: string[]; onchain_signers: unknown[] }>
> {
  return Promise.all(
    contracts.map(async (contract) => ({
      ...contract,
      onchain_signers: (await listContractSigners(indexerUrl, contract.contract_id)).signers,
    })),
  );
}

async function resolveSignerMutationTarget(
  opts: WalletMutationOpts,
): Promise<{ signerScVal: xdr.ScVal; signerDescriptor: Record<string, unknown> }> {
  const hasSecretRef = Boolean(opts.secretRef);
  const hasDelegatedAddress = Boolean(opts.delegatedAddress);
  const hasVerifierContractId = Boolean(opts.verifierContractId);
  const hasPublicKeyHex = Boolean(opts.publicKeyHex);

  if (hasSecretRef && (hasDelegatedAddress || hasPublicKeyHex)) {
    throw new Error("Use either --secret-ref or direct signer identity flags, not both.");
  }

  if (hasDelegatedAddress && (hasVerifierContractId || hasPublicKeyHex)) {
    throw new Error(
      "Delegated signer mutations accept only --delegated-address, or use --secret-ref.",
    );
  }

  if (hasPublicKeyHex && !hasVerifierContractId) {
    throw new Error(
      "External signer mutations require --verifier-contract-id with --public-key-hex.",
    );
  }

  if (hasVerifierContractId && !hasSecretRef && !hasPublicKeyHex) {
    throw new Error("External signer mutations require either --public-key-hex or --secret-ref.");
  }

  if (hasSecretRef) {
    const resolver = new SecretResolver();
    const secret = await resolver.resolve(opts.secretRef!);
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
    }

    if (hasVerifierContractId) {
      const publicKeyHex = credentialIdFromKeypair(keypair);
      return {
        signerScVal: makeExternalSignerScVal(opts.verifierContractId!, publicKeyHex),
        signerDescriptor: {
          type: "External",
          verifier_contract_id: opts.verifierContractId,
          public_key_hex: publicKeyHex,
          secret_ref: opts.secretRef,
        },
      };
    }

    const delegatedAddress = keypair.publicKey();
    return {
      signerScVal: makeDelegatedSignerScVal(delegatedAddress),
      signerDescriptor: {
        type: "Delegated",
        address: delegatedAddress,
        secret_ref: opts.secretRef,
      },
    };
  }

  if (hasDelegatedAddress) {
    return {
      signerScVal: makeDelegatedSignerScVal(opts.delegatedAddress!),
      signerDescriptor: {
        type: "Delegated",
        address: opts.delegatedAddress,
      },
    };
  }

  if (hasVerifierContractId && hasPublicKeyHex) {
    return {
      signerScVal: makeExternalSignerScVal(opts.verifierContractId!, opts.publicKeyHex!),
      signerDescriptor: {
        type: "External",
        verifier_contract_id: opts.verifierContractId,
        public_key_hex: opts.publicKeyHex,
      },
    };
  }

  throw new Error(
    "Pass a signer target using --secret-ref, --delegated-address, or --verifier-contract-id with --public-key-hex.",
  );
}

async function runSignerMutation(
  opts: WalletMutationOpts,
  functionName: "add_signer" | "remove_signer",
  signerScVal: xdr.ScVal,
  signerDescriptor: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig(opts.config);
  const { name: networkName, config: network } = resolveNetwork(config, opts.network);
  const accountAlias = opts.account;
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

const program = new Command();
program
  .name("walleterm")
  .description("OpenZeppelin smart-account interface for Stellar")
  .addHelpText(
    "after",
    [
      "",
      "Primary flows:",
      "  walleterm review --in ./unsigned.json",
      "  walleterm sign --in ./unsigned.json --out ./signed.json",
      "  walleterm submit --in ./signed.json --mode channels",
      "  walleterm wallet lookup --secret-ref op://Private/walleterm-testnet/delegated_seed",
      "  walleterm wallet lookup --secret-ref keychain://walleterm-testnet/delegated_seed",
      "  walleterm wallet create --wasm-hash <hash> --delegated-address G... --out ./deploy.tx.xdr",
      "  walleterm wallet signer add --account treasury --secret-ref <ref> --out ./add.bundle.json",
      "  walleterm pay https://api.example.com/resource --secret-ref op://Private/testnet/seed",
      "  walleterm pay https://api.example.com/resource --dry-run --format json",
    ].join("\n"),
  )
  .showHelpAfterError();

program
  .command("review")
  .description("inspect a payload and show whether the configured wallet can sign it")
  .requiredOption("--in <path>", "input file (xdr or json)")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--account <alias>", "smart account alias")
  .action(async (opts: InputOpts) => {
    const parsed = parseInputFile(opts.in);
    const inspection = inspectInput(parsed);
    const config = loadConfig(opts.config);
    const { name: networkName, config: network } = resolveNetwork(config, opts.network);
    const accountRef = resolveAccountForCommand(config, networkName, opts.account, parsed);

    if (!accountRef) {
      process.stdout.write(
        `${JSON.stringify({
          inspection,
          signability: null,
          account: null,
          note: "No smart account selected. Pass --account <alias> or configure exactly one account on the selected network.",
        })}\n`,
      );
      return;
    }

    const resolver = new SecretResolver();
    const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);
    const signability = canSignInput(parsed, {
      config,
      networkName,
      network,
      accountRef,
      runtimeSigners,
      expirationLedger: 0,
    });

    process.stdout.write(
      `${JSON.stringify({
        inspection,
        signability,
        account: accountRef.alias,
        contract_id: accountRef.account.contract_id,
      })}\n`,
    );
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
  .option("--channels-api-key-ref <ref>", "channels API key secret ref")
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
    const result = await submitViaChannels(parsed, network, resolver, {
      channelsBaseUrl: opts.channelsBaseUrl,
      channelsApiKey: opts.channelsApiKey,
      channelsApiKeyRef: opts.channelsApiKeyRef,
      pluginId: opts.pluginId,
    } satisfies SubmitNetworkOverrides);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

program
  .command("pay")
  .description("make an HTTP request to an x402-protected endpoint")
  .argument("<url>", "resource URL")
  .option("--method <method>", "HTTP method", "GET")
  .option("--header <header>", "HTTP header (repeatable, Name: Value)", collectValues, [])
  .option("--data <body>", "request body")
  .option("--network <name>", "network name")
  .option("--secret-ref <ref>", "keypair secret ref to pay from")
  .option("--format <mode>", "body | json", "body")
  .option("--out <path>", "write response body to a file instead of stdout")
  .option("--dry-run", "show 402 details without paying", false)
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .action(async (url: string, opts: PayOpts) => {
    const config = loadConfig(opts.config);
    const { config: network } = resolveNetwork(config, opts.network);

    const secretRef = opts.secretRef ?? config.x402?.default_payer_secret_ref;
    if (!secretRef) {
      throw new Error(
        "No payer specified. Pass --secret-ref or set x402.default_payer_secret_ref in config.",
      );
    }

    const resolver = new SecretResolver();
    const secret = await resolver.resolve(secretRef);
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
    }

    const x402Network = passphraseToX402Network(network.network_passphrase);
    const signer = createWalletermSigner(keypair, x402Network);
    const handler = createX402HttpHandler(signer, x402Network, network.rpc_url);

    const headers: Record<string, string> = {};
    for (const h of opts.header) {
      const idx = h.indexOf(":");
      if (idx < 0) {
        throw new Error(`Invalid header format: ${h}. Expected "Name: Value".`);
      }
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }

    const result = await executeX402Request(handler, {
      url,
      method: opts.method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: opts.data,
      x402Network,
      dryRun: opts.dryRun,
      fetchFn: fetch,
    });

    if (opts.out) {
      const bodyBuf = Buffer.from(result.body);
      writeFileSync(opts.out, bodyBuf);
      const contentType = result.responseHeaders["content-type"];
      process.stdout.write(
        `${JSON.stringify({
          paid: result.paid,
          status: result.status,
          payer: keypair.publicKey(),
          content_type: contentType ?? null,
          size: bodyBuf.length,
          file: opts.out,
          settlement: result.settlement ?? null,
        })}\n`,
      );
    } else if (opts.format === "json") {
      process.stdout.write(
        `${JSON.stringify({
          paid: result.paid,
          status: result.status,
          payer: keypair.publicKey(),
          response_headers: result.responseHeaders,
          payment_required: result.paymentRequired,
          payment_payload: result.paymentPayload,
          settlement: result.settlement,
          body: Buffer.from(result.body).toString("base64"),
        })}\n`,
      );
    } else {
      const contentType = result.responseHeaders["content-type"];
      if (contentType) {
        process.stderr.write(`content-type: ${contentType}\n`);
      }
      process.stdout.write(Buffer.from(result.body));
    }
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

setup
  .command("keychain")
  .description("bootstrap macOS keychain secrets for wallet creation/signing")
  .option(
    "--service <name>",
    "macOS keychain service name (default: walleterm-testnet or walleterm-mainnet by network)",
  )
  .option("--network <name>", "network context (used for defaults)", "testnet")
  .option("--keychain <path>", "custom keychain path (defaults to the login keychain)")
  .option("--deployer-seed <seed>", "existing deployer S... seed (if provided, it will be stored)")
  .option("--delegated-seed <seed>", "existing delegated S... seed (defaults to generated)")
  .option(
    "--channels-api-key <key>",
    "channels API key (defaults to auto-generated on testnet/mainnet)",
  )
  .option(
    "--include-deployer-seed",
    "store deployer seed in the macOS keychain (default uses smart-account-kit deterministic deployer)",
    false,
  )
  .option("--force", "overwrite existing keychain entries", false)
  .option("--json", "print only json output", false)
  .action(async (opts: SetupKeychainOpts) => {
    const networkName = opts.network;
    const result = await setupMacOSKeychainForWallet({
      service: opts.service ?? defaultServiceForNetwork(networkName),
      network: networkName,
      keychain: opts.keychain,
      deployerSeed: opts.deployerSeed,
      delegatedSeed: opts.delegatedSeed,
      channelsApiKey: opts.channelsApiKey,
      includeDeployerSeed: opts.includeDeployerSeed ? true : undefined,
      overwriteExisting: Boolean(opts.force),
    });

    if (!opts.json) {
      process.stderr.write("macOS keychain wallet bootstrap complete.\n");
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

const wallet = program
  .command("wallet")
  .description("OpenZeppelin smart-account wallet management")
  .addHelpText(
    "after",
    [
      "",
      "Primary wallet flows:",
      "  walleterm wallet lookup --secret-ref op://Private/walleterm-testnet/delegated_seed",
      "  walleterm wallet lookup --secret-ref keychain://walleterm-testnet/delegated_seed",
      "  walleterm wallet create --wasm-hash <hash> --delegated-address G... --out ./deploy.tx.xdr",
      "  walleterm wallet signer add --account treasury --secret-ref <ref> --out ./add.bundle.json",
      "  walleterm wallet signer remove --account treasury --secret-ref <ref> --out ./remove.bundle.json",
    ].join("\n"),
  );

wallet
  .command("lookup")
  .description("resolve a signer, wallet, or contract into the smart-account view")
  .option("--account <alias>", "configured smart account alias")
  .option("--address <stellar-address>", "G... or C... address")
  .option("--contract-id <contract-id>", "smart account contract C-address")
  .option("--secret-ref <ref>", "secret ref to Stellar secret seed")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--indexer-url <url>", "override indexer base URL")
  .action(async (opts: WalletLookupOpts) => {
    const config = loadConfig(opts.config);
    const { name: networkName, config: network } = resolveNetwork(config, opts.network);
    const indexerUrl = resolveIndexerUrl(network, opts.indexerUrl);

    const selectors = [opts.account, opts.address, opts.contractId, opts.secretRef].filter(Boolean);
    if (selectors.length !== 1) {
      throw new Error("Pass exactly one of --account, --address, --contract-id, or --secret-ref.");
    }

    if (opts.account) {
      const accountAlias = opts.account;
      const account = config.smart_accounts[accountAlias];
      if (!account) throw new Error(`Smart account '${accountAlias}' not found`);
      if (account.network !== networkName) {
        throw new Error(
          `Smart account '${accountAlias}' belongs to network '${account.network}', not '${networkName}'`,
        );
      }

      const local = listSignerConfig({ alias: accountAlias, account });
      const onchain = await listContractSigners(indexerUrl, account.contract_id);
      process.stdout.write(
        `${JSON.stringify({
          mode: "account",
          query: { account: accountAlias },
          count: 1,
          wallets: [
            {
              contract_id: account.contract_id,
              configured_account: accountAlias,
              configured_signers: local,
              onchain_signers: onchain.signers,
            },
          ],
        })}\n`,
      );
      return;
    }

    if (opts.contractId || opts.address?.startsWith("C")) {
      const contractId = opts.contractId ?? opts.address!;
      const onchain = await listContractSigners(indexerUrl, contractId);
      process.stdout.write(
        `${JSON.stringify({
          mode: "contract",
          query: { contract_id: contractId },
          count: 1,
          wallets: [{ contract_id: contractId, onchain_signers: onchain.signers }],
        })}\n`,
      );
      return;
    }

    if (opts.address) {
      const discovered = await discoverContractsByAddress(indexerUrl, opts.address);
      const contracts = await enrichContractsWithOnchainSigners(
        indexerUrl,
        dedupeContractsById(discovered.contracts).map((contract) => ({
          ...contract,
          lookup_types: ["delegated"],
        })),
      );
      process.stdout.write(
        `${JSON.stringify({
          mode: "address",
          query: { address: opts.address },
          count: contracts.length,
          wallets: contracts,
        })}\n`,
      );
      return;
    }

    const resolver = new SecretResolver();
    const secret = await resolver.resolve(opts.secretRef!);
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
    }

    const signerAddress = keypair.publicKey();
    const credentialId = credentialIdFromKeypair(keypair);
    const [delegated, external] = await Promise.all([
      discoverContractsByAddress(indexerUrl, signerAddress),
      discoverContractsByCredentialId(indexerUrl, credentialId),
    ]);
    const sourceByContractId = new Map<string, Set<"delegated" | "external">>();
    for (const contract of delegated.contracts) {
      const existing = sourceByContractId.get(contract.contract_id) ?? new Set();
      existing.add("delegated");
      sourceByContractId.set(contract.contract_id, existing);
    }
    for (const contract of external.contracts) {
      const existing = sourceByContractId.get(contract.contract_id) ?? new Set();
      existing.add("external");
      sourceByContractId.set(contract.contract_id, existing);
    }
    const contracts = await enrichContractsWithOnchainSigners(
      indexerUrl,
      dedupeContractsById([...delegated.contracts, ...external.contracts]).map((contract) => {
        const lookupTypes = sourceByContractId.get(contract.contract_id)!;
        return {
          ...contract,
          lookup_types: [...lookupTypes],
        };
      }),
    );
    process.stdout.write(
      `${JSON.stringify({
        mode: "secret-ref",
        query: {
          secret_ref: opts.secretRef,
          derived_address: signerAddress,
          credential_id: credentialId,
        },
        count: contracts.length,
        wallets: contracts,
      })}\n`,
    );
  });

const signer = wallet.command("signer").description("manage smart-account signers");

signer
  .command("generate")
  .description("generate a new Stellar signer keypair")
  .action(() => {
    process.stdout.write(`${JSON.stringify(buildKeypairJson(Keypair.random()))}\n`);
  });

async function runSignerMutationCommand(
  opts: WalletMutationOpts,
  functionName: "add_signer" | "remove_signer",
): Promise<void> {
  const { signerScVal, signerDescriptor } = await resolveSignerMutationTarget(opts);
  await runSignerMutation(opts, functionName, signerScVal, signerDescriptor);
}

signer
  .command("add")
  .description("build and sign an add_signer bundle")
  .requiredOption("--account <alias>", "smart account alias")
  .option("--context-rule-id <n>", "context rule id (default: 0)", "0")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .option("--secret-ref <ref>", "derive signer identity from secret ref")
  .option("--delegated-address <g-address>", "delegated signer G-address")
  .option("--verifier-contract-id <contract-id>", "verifier contract C-address")
  .option("--public-key-hex <hex>", "32-byte ed25519 public key hex")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutationCommand(opts, "add_signer");
  });

signer
  .command("remove")
  .description("build and sign a remove_signer bundle")
  .requiredOption("--account <alias>", "smart account alias")
  .option("--context-rule-id <n>", "context rule id (default: 0)", "0")
  .requiredOption("--out <path>", "output bundle json path")
  .option("--config <path>", "config TOML path", "walleterm.toml")
  .option("--network <name>", "network name")
  .option("--ttl-seconds <n>", "auth ttl in seconds")
  .option("--latest-ledger <n>", "override latest ledger sequence")
  .option("--secret-ref <ref>", "derive signer identity from secret ref")
  .option("--delegated-address <g-address>", "delegated signer G-address")
  .option("--verifier-contract-id <contract-id>", "verifier contract C-address")
  .option("--public-key-hex <hex>", "32-byte ed25519 public key hex")
  .action(async (opts: WalletMutationOpts) => {
    await runSignerMutationCommand(opts, "remove_signer");
  });

wallet
  .command("create")
  .description("build a deployment transaction for a new OZ smart account")
  .option(
    "--deployer-secret-ref <ref>",
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
  .option("--channels-api-key-ref <ref>", "channels API key secret ref")
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
        submission = await submitViaChannels(parsed, network, resolver, {
          channelsBaseUrl: opts.channelsBaseUrl,
          channelsApiKey: opts.channelsApiKey,
          channelsApiKeyRef: opts.channelsApiKeyRef,
          pluginId: opts.pluginId,
        } satisfies SubmitNetworkOverrides);
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
