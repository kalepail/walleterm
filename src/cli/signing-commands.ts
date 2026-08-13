import { Command } from "commander";
import {
  parseInputFile,
  reviewConfiguredInput,
  signConfiguredInput,
  writeOutput,
} from "../core.js";
import { loadConfig } from "../config.js";
import { submitConfiguredInput } from "../submit.js";
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
  mode: string;
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
      const config = loadConfig(opts.config);
      const result = await reviewConfiguredInput({
        config,
        input: parsed,
        network: opts.network,
        account: opts.account,
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
      const { output, report } = await signConfiguredInput({
        config,
        input: parsed,
        network: opts.network,
        account: opts.account,
        ttlSeconds: parseOptionalInt(opts.ttlSeconds),
        latestLedger: parseOptionalInt(opts.latestLedger),
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
      const result = await submitConfiguredInput({
        config,
        input: parsed,
        network: opts.network,
        mode: opts.mode,
        channels: {
          channelsBaseUrl: opts.channelsBaseUrl,
          channelsApiKey: opts.channelsApiKey,
          channelsApiKeyRef: opts.channelsApiKeyRef,
          pluginId: opts.pluginId,
        },
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}
