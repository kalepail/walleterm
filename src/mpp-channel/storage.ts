import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { MppChannelConfig } from "../config.js";
import type {
  MppChannelLifecycleState,
  MppChannelStateChange,
  MppChannelStateTransition,
  StoredMppChannel,
} from "./types.js";

interface StoredMppChannelFile {
  active_channel_by_network: Record<string, string>;
  channels: Record<string, StoredMppChannel>;
}

function emptyChannelFile(): StoredMppChannelFile {
  return {
    active_channel_by_network: {},
    channels: {},
  };
}

function readChannelFile(path: string): StoredMppChannelFile {
  if (!existsSync(path)) return emptyChannelFile();
  return JSON.parse(readFileSync(path, "utf8")) as StoredMppChannelFile;
}

function writeChannelFile(path: string, data: StoredMppChannelFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function resolveMppStatePath(configPath: string, channelConfig?: MppChannelConfig): string {
  if (channelConfig?.state_file) {
    return resolvePath(dirname(configPath), channelConfig.state_file);
  }
  return resolvePath(dirname(configPath), `${configPath.split("/").pop()}.mpp-channels.json`);
}

export function resolveStoredChannel(
  statePath: string,
  networkName: string,
  explicitChannelId?: string,
): StoredMppChannel | null {
  const file = readChannelFile(statePath);
  const channelId = explicitChannelId ?? file.active_channel_by_network[networkName];
  if (!channelId) return null;
  return file.channels[channelId] ?? null;
}

type ExistingChannelChange = Exclude<MppChannelStateTransition["type"], "opened">;

const allowedLifecycleStates: Record<ExistingChannelChange, readonly MppChannelLifecycleState[]> = {
  "topped-up": ["open"],
  "voucher-remembered": ["open"],
  settled: ["open"],
  "close-started": ["open"],
  closed: ["open", "closing"],
  refunded: ["closing"],
};

function parseCumulativeAmount(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return BigInt(value);
}

function validateMppChannelStateTransition(
  file: StoredMppChannelFile,
  transition: MppChannelStateTransition,
): void {
  const existing = file.channels[transition.channelId];
  if (transition.type === "opened") {
    if (existing) {
      throw new Error(`MPP channel ${transition.channelId} already exists`);
    }
    return;
  }
  if (!existing) {
    throw new Error(`MPP channel ${transition.channelId} does not exist`);
  }

  const lifecycleState = existing.lifecycle_state ?? "open";
  if (!allowedLifecycleStates[transition.type].includes(lifecycleState)) {
    throw new Error(
      `MPP channel change '${transition.type}' is not allowed from lifecycle state '${lifecycleState}'`,
    );
  }

  if ("cumulativeAmount" in transition) {
    const currentAmount = parseCumulativeAmount(
      existing.cumulative_amount ?? "0",
      "Stored MPP channel cumulative amount",
    );
    const nextAmount = parseCumulativeAmount(
      transition.cumulativeAmount,
      "MPP channel cumulative amount",
    );
    if (nextAmount < currentAmount) {
      throw new Error(
        `MPP channel cumulative amount ${transition.cumulativeAmount} is below stored amount ${existing.cumulative_amount ?? "0"}`,
      );
    }
  }
}

export function assertMppChannelStateChangeAllowed(
  statePath: string,
  transition: MppChannelStateTransition,
): void {
  validateMppChannelStateTransition(readChannelFile(statePath), transition);
}

function mergeChannelState(
  existing: StoredMppChannel | undefined,
  change: MppChannelStateChange,
): StoredMppChannel {
  const updatedAt = new Date().toISOString();

  switch (change.type) {
    case "opened":
      return {
        channel_id: change.channelId,
        network_name: change.networkName,
        network_passphrase: change.networkPassphrase,
        source_account: change.sourceAccount,
        secret_ref: change.secretRef,
        deposit: change.deposit,
        cumulative_amount: "0",
        refund_waiting_period: change.refundWaitingPeriod,
        factory_contract_id: change.factoryContractId,
        token_contract_id: change.tokenContractId,
        recipient: change.recipient,
        lifecycle_state: "open",
        opened_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
    case "topped-up":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: change.networkName,
        network_passphrase: change.networkPassphrase,
        source_account: change.sourceAccount,
        secret_ref: change.secretRef ?? existing?.secret_ref,
        deposit: existing?.deposit
          ? (BigInt(existing.deposit) + BigInt(change.amount)).toString()
          : change.amount,
        cumulative_amount: existing?.cumulative_amount ?? "0",
        lifecycle_state: existing?.lifecycle_state ?? "open",
        last_topup_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
    case "voucher-remembered":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: change.networkName,
        network_passphrase: change.networkPassphrase,
        source_account: change.sourceAccount,
        secret_ref: change.secretRef ?? existing?.secret_ref,
        cumulative_amount: change.cumulativeAmount,
        last_voucher_amount: change.cumulativeAmount,
        last_voucher_signature: change.signatureHex,
        lifecycle_state: existing?.lifecycle_state ?? "open",
        updated_at: updatedAt,
      };
    case "settled":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: existing?.network_name ?? change.networkName,
        network_passphrase: existing?.network_passphrase ?? change.networkPassphrase,
        source_account: existing?.source_account ?? "",
        cumulative_amount: change.cumulativeAmount,
        last_voucher_amount: change.cumulativeAmount,
        last_voucher_signature: change.signatureHex,
        lifecycle_state: existing?.lifecycle_state ?? "open",
        last_settle_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
    case "close-started":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: existing?.network_name ?? change.networkName,
        network_passphrase: existing?.network_passphrase ?? change.networkPassphrase,
        source_account: existing?.source_account ?? change.sourceAccount,
        lifecycle_state: "closing",
        close_start_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
    case "closed":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: existing?.network_name ?? "",
        network_passphrase: existing?.network_passphrase ?? change.networkPassphrase,
        source_account: existing?.source_account ?? change.sourceAccount,
        cumulative_amount: change.cumulativeAmount,
        last_voucher_amount: change.cumulativeAmount,
        last_voucher_signature: change.signatureHex,
        lifecycle_state: "closed",
        close_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
    case "refunded":
      return {
        ...existing,
        channel_id: change.channelId,
        network_name: existing?.network_name ?? change.networkName,
        network_passphrase: existing?.network_passphrase ?? change.networkPassphrase,
        source_account: existing?.source_account ?? change.sourceAccount,
        lifecycle_state: "refunded",
        refund_tx_hash: change.txHash,
        updated_at: updatedAt,
      };
  }
}

export function applyMppChannelStateChange(
  statePath: string,
  change: MppChannelStateChange,
): StoredMppChannel {
  const file = readChannelFile(statePath);
  const existing = file.channels[change.channelId];
  validateMppChannelStateTransition(file, change);
  const channel = mergeChannelState(existing, change);
  file.channels[channel.channel_id] = channel;

  if (change.type === "closed" || change.type === "refunded") {
    if (file.active_channel_by_network[channel.network_name] === channel.channel_id) {
      delete file.active_channel_by_network[channel.network_name];
    }
  } else {
    file.active_channel_by_network[channel.network_name] = channel.channel_id;
  }

  writeChannelFile(statePath, file);
  return channel;
}

export function rememberMppVoucher(
  statePath: string,
  parameters: {
    channelId: string;
    networkName: string;
    networkPassphrase: string;
    sourceAccount: string;
    secretRef?: string;
    cumulativeAmount: string;
    signatureHex: string;
  },
): StoredMppChannel {
  return applyMppChannelStateChange(statePath, {
    type: "voucher-remembered",
    channelId: parameters.channelId,
    networkName: parameters.networkName,
    networkPassphrase: parameters.networkPassphrase,
    sourceAccount: parameters.sourceAccount,
    secretRef: parameters.secretRef,
    cumulativeAmount: parameters.cumulativeAmount,
    signatureHex: parameters.signatureHex,
  });
}
