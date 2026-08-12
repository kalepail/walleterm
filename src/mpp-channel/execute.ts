import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig, resolveNetwork, type WalletermConfig } from "../config.js";
import { SecretResolver } from "../secrets.js";
import { requireKeypairSigner, resolveSigner } from "../signer.js";
import {
  closeMppChannel,
  getMppChannelStatus,
  openMppChannel,
  refundMppChannel,
  settleMppChannel,
  startMppChannelClose,
  topUpMppChannel,
} from "./lifecycle.js";
import { resolveMppStatePath, resolveStoredChannel } from "./storage.js";
import type { MppChannelLifecycleRequest, StoredMppChannel } from "./types.js";

interface LifecycleContext {
  config: WalletermConfig;
  networkName: string;
  network: WalletermConfig["networks"][string];
  statePath: string;
}

function parseBigIntAmount(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer string`);
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value '${value}'`);
  }
  return parsed;
}

function requireNonNegativeInt(value: number | undefined, label: string): number {
  if (value === undefined || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function loadLifecycleContext(request: MppChannelLifecycleRequest): LifecycleContext {
  const config = loadConfig(request.configPath);
  const { name: networkName, config: network } = resolveNetwork(config, request.network);
  return {
    config,
    networkName,
    network,
    statePath: resolveMppStatePath(request.configPath, config.payments?.mpp?.channel),
  };
}

function requireChannelRecord(
  context: LifecycleContext,
  explicitChannelId?: string,
): StoredMppChannel {
  const configuredChannelId = context.config.payments?.mpp?.channel?.default_channel_contract_id;
  const record = resolveStoredChannel(
    context.statePath,
    context.networkName,
    explicitChannelId ?? configuredChannelId,
  );
  if (!record) {
    throw new Error(
      "No MPP channel selected. Pass --channel-id, configure payments.mpp.channel.default_channel_contract_id, or open a channel first.",
    );
  }
  return record;
}

function assertChannelRole(
  record: StoredMppChannel,
  keypair: Keypair,
  role: "funder" | "recipient",
): void {
  const expected = role === "funder" ? record.source_account : record.recipient;
  if (!expected) return;
  if (keypair.publicKey() !== expected) {
    throw new Error(
      `Configured signer ${keypair.publicKey()} does not match the channel ${role} ${expected}.`,
    );
  }
}

async function withSigner<T>(
  secretRef: string,
  record: StoredMppChannel | undefined,
  role: "funder" | "recipient" | undefined,
  run: (keypair: Keypair) => Promise<T>,
): Promise<T> {
  const resolver = new SecretResolver();
  try {
    const signer = await resolveSigner(
      secretRef,
      resolver,
      "MPP channel credential must resolve to a valid Stellar secret seed (S...)",
    );
    const keypair = requireKeypairSigner(
      signer,
      "MPP channel operations require a signer with secret-seed capability. The selected credential does not provide this capability.",
    ).keypair();
    if (record && role) assertChannelRole(record, keypair, role);
    return await run(keypair);
  } finally {
    resolver.clearCache();
  }
}

function unsupportedAction(_request: never): never {
  throw new Error("Unsupported MPP channel action.");
}

export async function executeMppChannelLifecycle(request: MppChannelLifecycleRequest) {
  const action = request.action;
  const context = loadLifecycleContext(request);
  const channelConfig = context.config.payments?.mpp?.channel;

  if (action === "open") {
    const secretRef = request.secretRef ?? context.config.payments?.mpp?.default_payer_secret_ref;
    if (!secretRef) {
      throw new Error(
        "No funder specified. Pass --secret-ref or set payments.mpp.default_payer_secret_ref in config.",
      );
    }
    const factoryContractId = request.factoryContractId ?? channelConfig?.factory_contract_id;
    const tokenContractId = request.tokenContractId ?? channelConfig?.token_contract_id;
    const recipient = request.recipient ?? channelConfig?.recipient;
    const depositRaw = request.deposit ?? channelConfig?.default_deposit;
    const refundWaitingPeriodRaw =
      request.refundWaitingPeriod ?? channelConfig?.refund_waiting_period?.toString();
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

    return withSigner(secretRef, undefined, undefined, (keypair) =>
      openMppChannel({
        rpcUrl: context.network.rpc_url,
        networkName: context.networkName,
        networkPassphrase: context.network.network_passphrase,
        keypair,
        factoryContractId,
        tokenContractId,
        recipient,
        deposit: parseBigIntAmount(depositRaw, "deposit"),
        refundWaitingPeriod: requireNonNegativeInt(
          parseOptionalInt(refundWaitingPeriodRaw),
          "refund_waiting_period",
        ),
        statePath: context.statePath,
        secretRef,
      }),
    );
  }

  const record = requireChannelRecord(context, request.channelId);

  if (action === "status") {
    const sourceAccount = record.source_account ?? channelConfig?.source_account;
    if (!sourceAccount) {
      throw new Error("MPP channel status requires a funded source account for simulations.");
    }
    const status = await getMppChannelStatus({
      rpcUrl: context.network.rpc_url,
      networkPassphrase: context.network.network_passphrase,
      channelId: record.channel_id,
      sourceAccount,
    });
    return { ...status, stored: record };
  }

  if (action === "topup") {
    const secretRef =
      request.secretRef ??
      record.secret_ref ??
      context.config.payments?.mpp?.default_payer_secret_ref;
    if (!secretRef) {
      throw new Error("No funder specified for channel topup.");
    }
    return withSigner(secretRef, record, "funder", (keypair) =>
      topUpMppChannel({
        rpcUrl: context.network.rpc_url,
        networkName: context.networkName,
        networkPassphrase: context.network.network_passphrase,
        keypair,
        channelId: record.channel_id,
        amount: parseBigIntAmount(request.amount, "amount"),
        statePath: context.statePath,
        secretRef,
      }),
    );
  }

  if (action === "settle" || action === "close") {
    const secretRef = request.secretRef ?? channelConfig?.recipient_secret_ref;
    if (!secretRef) {
      const operation = action === "settle" ? "settle" : "close";
      throw new Error(
        `No recipient signer specified for channel ${operation}. Pass --secret-ref or set payments.mpp.channel.recipient_secret_ref.`,
      );
    }
    const amountRaw = request.amount ?? record.last_voucher_amount ?? record.cumulative_amount;
    const signature = request.signature ?? record.last_voucher_signature;
    if (!amountRaw || !signature) {
      if (action === "settle") {
        throw new Error(
          "No settlement voucher available. Pass --amount and --signature, or make at least one MPP channel payment first.",
        );
      }
      throw new Error(
        "No close voucher available. Pass --amount and --signature, or make at least one MPP channel payment first.",
      );
    }

    return withSigner(secretRef, record, "recipient", (keypair) => {
      const common = {
        rpcUrl: context.network.rpc_url,
        networkPassphrase: context.network.network_passphrase,
        keypair,
        channelId: record.channel_id,
        amount: parseBigIntAmount(amountRaw, "amount"),
        signatureHex: signature,
        statePath: context.statePath,
      };
      if (action === "close") return closeMppChannel(common);
      return settleMppChannel({ ...common, networkName: context.networkName });
    });
  }

  if (action !== "close-start" && action !== "refund") {
    return unsupportedAction(action);
  }

  const secretRef =
    request.secretRef ??
    record.secret_ref ??
    context.config.payments?.mpp?.default_payer_secret_ref;
  if (!secretRef) {
    throw new Error(`No funder specified for channel ${action}.`);
  }
  return withSigner(secretRef, record, "funder", (keypair) => {
    const common = {
      rpcUrl: context.network.rpc_url,
      networkName: context.networkName,
      networkPassphrase: context.network.network_passphrase,
      keypair,
      channelId: record.channel_id,
      statePath: context.statePath,
    };
    if (action === "close-start") return startMppChannelClose(common);
    if (action === "refund") return refundMppChannel(common);
    return unsupportedAction(action);
  });
}
