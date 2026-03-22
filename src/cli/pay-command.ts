import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { loadConfig, resolveNetwork } from "../config.js";
import { buildPaymentJsonResult, executePaymentRequest } from "../payments/index.js";
import { SecretResolver } from "../secrets.js";
import { collectValues, resolveMppChannelStatePath } from "./shared.js";

interface PayOpts {
  config: string;
  network?: string;
  protocol?: string;
  x402Scheme?: string;
  intent?: string;
  secretRef?: string;
  sourceAccount?: string;
  method: string;
  header: string[];
  data?: string;
  x402ChannelDeposit?: string;
  x402ChannelStateFile?: string;
  x402ChannelCommitmentSecretRef?: string;
  format: string;
  out?: string;
  dryRun: boolean;
  yes: boolean;
}

export function registerPayCommand(program: Command): void {
  program
    .command("pay")
    .description("make an HTTP request to an x402- or MPP-protected endpoint")
    .argument("<url>", "resource URL")
    .option("--method <method>", "HTTP method", "GET")
    .option("--header <header>", "HTTP header (repeatable, Name: Value)", collectValues, [])
    .option("--data <body>", "request body")
    .option("--network <name>", "network name")
    .option("--protocol <protocol>", "payment protocol: x402 | mpp")
    .option("--x402-scheme <scheme>", "x402 scheme: exact | channel | auto")
    .option("--intent <intent>", "MPP intent: charge | channel")
    .option("--secret-ref <ref>", "keypair secret ref to pay from")
    .option("--source-account <address>", "source account override for MPP channel simulations")
    .option("--x402-channel-deposit <amount>", "x402 channel deposit override")
    .option("--x402-channel-state-file <path>", "x402 channel state file override")
    .option(
      "--x402-channel-commitment-secret-ref <ref>",
      "x402 channel commitment key secret ref override",
    )
    .option("--format <mode>", "body | json", "body")
    .option("--out <path>", "write response body to a file instead of stdout")
    .option("--dry-run", "show 402 details without paying", false)
    .option("--yes", "skip max_payment_amount cap check", false)
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .action(async (url: string, opts: PayOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);

      const resolver = new SecretResolver();
      try {
        const payment = await executePaymentRequest(config, networkName, network, resolver, {
          url,
          configPath: opts.config,
          method: opts.method,
          rawHeaders: opts.header,
          body: opts.data,
          protocol: opts.protocol,
          x402Scheme: opts.x402Scheme,
          intent: opts.intent,
          secretRef: opts.secretRef,
          sourceAccount: opts.sourceAccount,
          x402ChannelDeposit: opts.x402ChannelDeposit,
          x402ChannelStateFile: opts.x402ChannelStateFile,
          x402ChannelCommitmentSecretRef: opts.x402ChannelCommitmentSecretRef,
          dryRun: opts.dryRun,
          yes: opts.yes,
          fetchFn: fetch,
          mppChannelStatePath: resolveMppChannelStatePath(opts.config, config),
        });
        const { protocol, payer, result } = payment;

        if (opts.out) {
          const bodyBuf = Buffer.from(result.body);
          writeFileSync(opts.out, bodyBuf, { mode: 0o600 });
          const contentType = result.responseHeaders["content-type"];
          process.stdout.write(
            `${JSON.stringify({
              protocol,
              scheme: result.scheme ?? null,
              paid: result.paid,
              status: result.status,
              payer,
              content_type: contentType ?? null,
              size: bodyBuf.length,
              file: opts.out,
              settlement: result.settlement ?? null,
              settlement_error: result.settlementError ?? null,
              protocol_error: result.settlementError ?? null,
              channel: result.channel ?? null,
            })}\n`,
          );
        } else if (opts.format === "json") {
          process.stdout.write(
            `${JSON.stringify(buildPaymentJsonResult(protocol, payer, result))}\n`,
          );
        } else {
          const contentType = result.responseHeaders["content-type"];
          if (contentType) {
            process.stderr.write(`content-type: ${contentType}\n`);
          }
          process.stdout.write(Buffer.from(result.body));
        }
      } finally {
        resolver.clearCache();
      }
    });
}
