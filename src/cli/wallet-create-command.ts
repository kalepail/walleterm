import { Command } from "commander";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { parseInputFile, writeOutput } from "../core.js";
import { loadConfig, resolveAccount, resolveNetwork, type WalletermConfig } from "../config.js";
import { SecretResolver } from "../secrets.js";
import { KeypairSigner } from "../signer.js";
import { submitTxXdrViaRpc, submitViaChannels, type SubmitNetworkOverrides } from "../submit.js";
import {
  createWalletDeployTx,
  deriveSaltHexFromRawString,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
  smartAccountKitDeployerKeypair,
} from "../wallet.js";
import { collectValues } from "./shared.js";

interface WalletCreateOpts {
  config: string;
  network?: string;
  account?: string;
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

function resolveWalletCreateWasmHash(
  config: WalletermConfig,
  networkName: string,
  opts: WalletCreateOpts,
): string {
  const accountRef = resolveAccount(config, networkName, opts.account);
  const configuredHash = accountRef?.account.expected_wasm_hash;
  const explicitHash = opts.wasmHash;

  if (
    explicitHash &&
    configuredHash &&
    explicitHash.toLowerCase() !== configuredHash.toLowerCase()
  ) {
    throw new Error(
      `wallet create wasm hash mismatch for account '${accountRef!.alias}': explicit --wasm-hash does not match smart_accounts.${accountRef!.alias}.expected_wasm_hash`,
    );
  }

  const resolved = explicitHash ?? configuredHash;
  if (!resolved) {
    throw new Error(
      opts.account
        ? `No wasm hash provided. Pass --wasm-hash or set smart_accounts.${opts.account}.expected_wasm_hash.`
        : "No wasm hash provided. Pass --wasm-hash or select/configure an account with expected_wasm_hash.",
    );
  }

  return resolved;
}

export function registerWalletCreateCommand(wallet: Command): void {
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
    .option("--account <alias>", "smart account alias for config-driven defaults")
    .option("--wasm-hash <hex>", "smart account wasm hash (32-byte hex)")
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
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const resolver = new SecretResolver();

      try {
        let deployer;
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

        const wasmHash = resolveWalletCreateWasmHash(config, networkName, opts);

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
          deployer: new KeypairSigner(deployer),
          wasmHashHex: wasmHash,
          signers,
          saltHex: createSaltHex,
          sequenceOverride: opts.sequence,
          fee: opts.fee,
          skipPrepare: Boolean(opts.skipPrepare),
        });

        writeOutput(opts.out, txXdr);

        let submission: unknown;
        const shouldSubmit = Boolean(opts.submit) || config.app.default_submit_mode === "channels";
        if (shouldSubmit) {
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
            submitted: shouldSubmit,
            submission,
          })}\n`,
        );
      } finally {
        resolver.clearCache();
      }
    });
}
