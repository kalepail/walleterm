import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import {
  closeMppChannel,
  getMppChannelStatus,
  openMppChannel,
  refundMppChannel,
  settleMppChannel,
  startMppChannelClose,
  topUpMppChannel,
} from "../mpp-channel.js";
import { loadConfig, resolveNetwork } from "../config.js";
import { SecretResolver } from "../secrets.js";
import {
  assertMppChannelRole,
  parseBigIntAmount,
  parseOptionalInt,
  requireMppChannelRecord,
  requireNonNegativeInt,
  resolveMppChannelStatePath,
  resolveMppFunderSecretRef,
  resolveMppRecipientSecretRef,
} from "./shared.js";

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

interface ChannelCloseOpts extends ChannelBaseOpts {
  secretRef?: string;
  amount?: string;
  signature?: string;
}

interface ChannelSettleOpts extends ChannelBaseOpts {
  secretRef?: string;
  amount?: string;
  signature?: string;
}

interface ChannelCloseStartOpts extends ChannelBaseOpts {
  secretRef?: string;
}

interface ChannelRefundOpts extends ChannelBaseOpts {
  secretRef?: string;
}

interface ChannelStatusOpts extends ChannelBaseOpts {}

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
    .action(async (opts: ChannelOpenOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const channelConfig = config.payments?.mpp?.channel;
      const secretRef = resolveMppFunderSecretRef(config, opts.secretRef);
      if (!secretRef) {
        throw new Error(
          "No funder specified. Pass --secret-ref or set payments.mpp.default_payer_secret_ref in config.",
        );
      }
      const factoryContractId = opts.factoryContractId ?? channelConfig?.factory_contract_id;
      const tokenContractId = opts.tokenContractId ?? channelConfig?.token_contract_id;
      const recipient = opts.recipient ?? channelConfig?.recipient;
      const depositRaw = opts.deposit ?? channelConfig?.default_deposit;
      const refundWaitingPeriodRaw =
        opts.refundWaitingPeriod ?? channelConfig?.refund_waiting_period?.toString();
      if (
        !factoryContractId ||
        !tokenContractId ||
        !recipient ||
        !depositRaw ||
        !refundWaitingPeriodRaw
      ) {
        throw new Error(
          "MPP channel open requires factory contract, token contract, recipient, deposit, and refund waiting period. Set them in flags or payments.mpp.channel config.",
        );
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        const result = await openMppChannel({
          rpcUrl: network.rpc_url,
          networkName,
          networkPassphrase: network.network_passphrase,
          keypair,
          factoryContractId,
          tokenContractId,
          recipient,
          deposit: parseBigIntAmount(depositRaw, "deposit"),
          refundWaitingPeriod: requireNonNegativeInt(
            parseOptionalInt(refundWaitingPeriodRaw),
            "refund_waiting_period",
          ),
          statePath: resolveMppChannelStatePath(opts.config, config),
          secretRef,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });

  channel
    .command("topup")
    .description("top up an existing MPP payment channel")
    .requiredOption("--amount <amount>", "top-up amount in stroops")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action(async (opts: ChannelTopUpOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const secretRef = opts.secretRef ?? record.secret_ref ?? resolveMppFunderSecretRef(config);
      if (!secretRef) {
        throw new Error("No funder specified for channel topup.");
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        assertMppChannelRole(record, keypair, "funder");
        const result = await topUpMppChannel({
          rpcUrl: network.rpc_url,
          networkName,
          networkPassphrase: network.network_passphrase,
          keypair,
          channelId: record.channel_id,
          amount: parseBigIntAmount(opts.amount, "amount"),
          statePath: resolveMppChannelStatePath(opts.config, config),
          secretRef,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });

  channel
    .command("status")
    .description("show on-chain status for an MPP payment channel")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .action(async (opts: ChannelStatusOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const sourceAccount = record.source_account ?? config.payments?.mpp?.channel?.source_account;
      if (!sourceAccount) {
        throw new Error("MPP channel status requires a funded source account for simulations.");
      }
      const result = await getMppChannelStatus({
        rpcUrl: network.rpc_url,
        networkPassphrase: network.network_passphrase,
        channelId: record.channel_id,
        sourceAccount,
      });
      process.stdout.write(`${JSON.stringify({ ...result, stored: record })}\n`);
    });

  channel
    .command("settle")
    .description("recipient-side partial settlement using the latest remembered voucher")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "recipient transaction signer secret ref")
    .option("--amount <amount>", "cumulative amount in stroops")
    .option("--signature <hex>", "voucher signature hex")
    .action(async (opts: ChannelSettleOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const secretRef = resolveMppRecipientSecretRef(config, opts.secretRef);
      if (!secretRef) {
        throw new Error(
          "No recipient signer specified for channel settle. Pass --secret-ref or set payments.mpp.channel.recipient_secret_ref.",
        );
      }
      const amountRaw = opts.amount ?? record.last_voucher_amount ?? record.cumulative_amount;
      const signature = opts.signature ?? record.last_voucher_signature;
      if (!amountRaw || !signature) {
        throw new Error(
          "No settlement voucher available. Pass --amount and --signature, or make at least one MPP channel payment first.",
        );
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        assertMppChannelRole(record, keypair, "recipient");
        const result = await settleMppChannel({
          rpcUrl: network.rpc_url,
          networkName,
          networkPassphrase: network.network_passphrase,
          keypair,
          channelId: record.channel_id,
          amount: parseBigIntAmount(amountRaw, "amount"),
          signatureHex: signature,
          statePath: resolveMppChannelStatePath(opts.config, config),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });

  channel
    .command("close")
    .description("recipient-side final close using the latest remembered voucher")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "recipient transaction signer secret ref")
    .option("--amount <amount>", "cumulative amount in stroops")
    .option("--signature <hex>", "voucher signature hex")
    .action(async (opts: ChannelCloseOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const secretRef = resolveMppRecipientSecretRef(config, opts.secretRef);
      if (!secretRef) {
        throw new Error(
          "No recipient signer specified for channel close. Pass --secret-ref or set payments.mpp.channel.recipient_secret_ref.",
        );
      }
      const amountRaw = opts.amount ?? record.last_voucher_amount ?? record.cumulative_amount;
      const signature = opts.signature ?? record.last_voucher_signature;
      if (!amountRaw || !signature) {
        throw new Error(
          "No close voucher available. Pass --amount and --signature, or make at least one MPP channel payment first.",
        );
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        assertMppChannelRole(record, keypair, "recipient");
        const result = await closeMppChannel({
          rpcUrl: network.rpc_url,
          networkPassphrase: network.network_passphrase,
          keypair,
          channelId: record.channel_id,
          amount: parseBigIntAmount(amountRaw, "amount"),
          signatureHex: signature,
          statePath: resolveMppChannelStatePath(opts.config, config),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });

  channel
    .command("close-start")
    .description("funder-side start of the refund waiting period")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action(async (opts: ChannelCloseStartOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const secretRef = opts.secretRef ?? record.secret_ref ?? resolveMppFunderSecretRef(config);
      if (!secretRef) {
        throw new Error("No funder specified for channel close-start.");
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        assertMppChannelRole(record, keypair, "funder");
        const result = await startMppChannelClose({
          rpcUrl: network.rpc_url,
          networkName,
          networkPassphrase: network.network_passphrase,
          keypair,
          channelId: record.channel_id,
          statePath: resolveMppChannelStatePath(opts.config, config),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });

  channel
    .command("refund")
    .description("funder-side refund after the close waiting period has elapsed")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--channel-id <id>", "channel contract address")
    .option("--secret-ref <ref>", "funder keypair secret ref")
    .action(async (opts: ChannelRefundOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const record = requireMppChannelRecord(opts.config, config, networkName, opts.channelId);
      const secretRef = opts.secretRef ?? record.secret_ref ?? resolveMppFunderSecretRef(config);
      if (!secretRef) {
        throw new Error("No funder specified for channel refund.");
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(secretRef);
        const keypair = Keypair.fromSecret(secret);
        assertMppChannelRole(record, keypair, "funder");
        const result = await refundMppChannel({
          rpcUrl: network.rpc_url,
          networkName,
          networkPassphrase: network.network_passphrase,
          keypair,
          channelId: record.channel_id,
          statePath: resolveMppChannelStatePath(opts.config, config),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        resolver.clearCache();
      }
    });
}
