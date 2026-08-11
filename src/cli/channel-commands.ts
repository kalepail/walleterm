import { Command } from "commander";
import { executeMppChannelLifecycle, type MppChannelLifecycleRequest } from "../mpp-channel.js";

interface ChannelBaseOpts {
  config: string;
  network?: string;
  channelId?: string;
}

interface ChannelOpenOpts extends ChannelBaseOpts {
  secretRef?: string;
  deposit?: string;
  factoryContractId?: string;
  tokenContractId?: string;
  recipient?: string;
  refundWaitingPeriod?: string;
}

interface ChannelTopUpOpts extends ChannelBaseOpts {
  secretRef?: string;
  amount: string;
}

interface ChannelVoucherOpts extends ChannelBaseOpts {
  secretRef?: string;
  amount?: string;
  signature?: string;
}

interface ChannelFunderOpts extends ChannelBaseOpts {
  secretRef?: string;
}

async function runLifecycle(request: MppChannelLifecycleRequest): Promise<void> {
  const result = await executeMppChannelLifecycle(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function registerChannelCommands(program: Command): void {
  const channel = program.command("channel").description("MPP channel lifecycle helpers");

  channel
    .command("open")
    .description("open an MPP one-way payment channel and remember it locally")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .option("--deposit <amount>", "initial deposit in stroops")
    .option("--factory-contract-id <id>", "channel factory contract address")
    .option("--token-contract-id <id>", "token contract address")
    .option("--recipient <address>", "recipient address")
    .option("--refund-waiting-period <ledgers>", "refund waiting period in ledgers")
    .action((opts: ChannelOpenOpts) =>
      runLifecycle({
        action: "open",
        configPath: opts.config,
        network: opts.network,
        secretRef: opts.secretRef,
        deposit: opts.deposit,
        factoryContractId: opts.factoryContractId,
        tokenContractId: opts.tokenContractId,
        recipient: opts.recipient,
        refundWaitingPeriod: opts.refundWaitingPeriod,
      }),
    );

  channel
    .command("topup")
    .description("top up an existing MPP payment channel")
    .requiredOption("--amount <amount>", "top-up amount in stroops")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action((opts: ChannelTopUpOpts) =>
      runLifecycle({
        action: "topup",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
        secretRef: opts.secretRef,
        amount: opts.amount,
      }),
    );

  channel
    .command("status")
    .description("show on-chain status for an MPP payment channel")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .action((opts: ChannelBaseOpts) =>
      runLifecycle({
        action: "status",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
      }),
    );

  channel
    .command("settle")
    .description("recipient-side partial settlement using the latest remembered voucher")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "recipient transaction signer secret ref")
    .option("--amount <amount>", "cumulative amount in stroops")
    .option("--signature <hex>", "voucher signature hex")
    .action((opts: ChannelVoucherOpts) =>
      runLifecycle({
        action: "settle",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
        secretRef: opts.secretRef,
        amount: opts.amount,
        signature: opts.signature,
      }),
    );

  channel
    .command("close")
    .description("recipient-side final close using the latest remembered voucher")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "recipient transaction signer secret ref")
    .option("--amount <amount>", "cumulative amount in stroops")
    .option("--signature <hex>", "voucher signature hex")
    .action((opts: ChannelVoucherOpts) =>
      runLifecycle({
        action: "close",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
        secretRef: opts.secretRef,
        amount: opts.amount,
        signature: opts.signature,
      }),
    );

  channel
    .command("close-start")
    .description("funder-side start of the refund waiting period")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action((opts: ChannelFunderOpts) =>
      runLifecycle({
        action: "close-start",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
        secretRef: opts.secretRef,
      }),
    );

  channel
    .command("refund")
    .description("funder-side refund after the close waiting period has elapsed")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action((opts: ChannelFunderOpts) =>
      runLifecycle({
        action: "refund",
        configPath: opts.config,
        network: opts.network,
        channelId: opts.channelId,
        secretRef: opts.secretRef,
      }),
    );
}
