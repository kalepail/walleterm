import { Command } from "commander";
import {
  canSignInput,
  computeExpirationLedger,
  inspectInput,
  loadRuntimeSigners,
  parseInputFile,
  resolveAccountForCommand,
  signInput,
  writeOutput,
} from "../core.js";
import { loadConfig, resolveNetwork } from "../config.js";
import { SecretResolver } from "../secrets.js";
import { submitTxXdrViaRpc, submitViaChannels, type SubmitNetworkOverrides } from "../submit.js";
import { getSignerReconciliation, enforceStrictOnchainSigners } from "./onchain-signers.js";
import { parseOptionalInt } from "./shared.js";

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

interface SubmitOpts extends InputOpts {
  mode: "channels" | "rpc";
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}

export function registerSigningCommands(program: Command): void {
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
      try {
        const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);
        const signability = canSignInput(parsed, {
          config,
          networkName,
          network,
          accountRef,
          runtimeSigners,
          expirationLedger: 0,
        });

        let signerReconciliation: unknown = null;
        let signerReconciliationError: string | null = null;
        try {
          signerReconciliation = await getSignerReconciliation(config, network, accountRef.account);
        } catch (error) {
          signerReconciliationError = error instanceof Error ? error.message : String(error);
        }

        process.stdout.write(
          `${JSON.stringify({
            inspection,
            signability,
            account: accountRef.alias,
            contract_id: accountRef.account.contract_id,
            signer_reconciliation: signerReconciliation,
            signer_reconciliation_error: signerReconciliationError,
          })}\n`,
        );
      } finally {
        resolver.clearCache();
      }
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
      try {
        await enforceStrictOnchainSigners(config, network, accountRef.alias, accountRef.account);
        const runtimeSigners = await loadRuntimeSigners(accountRef, resolver);

        const ttlSeconds =
          parseOptionalInt(opts.ttlSeconds) ?? config.app.default_ttl_seconds ?? 30;
        const ledgerSeconds = config.app.assumed_ledger_time_seconds ?? 6;
        const latestLedger = parseOptionalInt(opts.latestLedger);

        const expirationLedger = await computeExpirationLedger(
          network,
          ttlSeconds,
          ledgerSeconds,
          latestLedger,
        );

        const { output, report } = await signInput(parsed, {
          config,
          networkName,
          network,
          accountRef,
          runtimeSigners,
          expirationLedger,
        });

        writeOutput(opts.out, output);
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } finally {
        resolver.clearCache();
      }
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

      if (opts.mode === "rpc") {
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
      try {
        const result = await submitViaChannels(parsed, network, resolver, {
          channelsBaseUrl: opts.channelsBaseUrl,
          channelsApiKey: opts.channelsApiKey,
          channelsApiKeyRef: opts.channelsApiKeyRef,
          pluginId: opts.pluginId,
        } satisfies SubmitNetworkOverrides);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });
}
