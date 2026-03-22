import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { MppChannelConfig } from "../config.js";
import type { StoredMppChannel } from "./types.js";

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

export function upsertStoredChannel(
  statePath: string,
  channel: StoredMppChannel,
  options: { makeActive?: boolean; clearActive?: boolean } = {},
): StoredMppChannel {
  const file = readChannelFile(statePath);
  file.channels[channel.channel_id] = channel;
  if (options.makeActive ?? true) {
    file.active_channel_by_network[channel.network_name] = channel.channel_id;
  }
  if (
    options.clearActive &&
    file.active_channel_by_network[channel.network_name] === channel.channel_id
  ) {
    delete file.active_channel_by_network[channel.network_name];
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
  const existing = resolveStoredChannel(statePath, parameters.networkName, parameters.channelId);
  return upsertStoredChannel(statePath, {
    channel_id: parameters.channelId,
    network_name: parameters.networkName,
    network_passphrase: parameters.networkPassphrase,
    source_account: parameters.sourceAccount,
    secret_ref: parameters.secretRef ?? existing?.secret_ref,
    deposit: existing?.deposit,
    cumulative_amount: parameters.cumulativeAmount,
    last_voucher_amount: parameters.cumulativeAmount,
    last_voucher_signature: parameters.signatureHex,
    refund_waiting_period: existing?.refund_waiting_period,
    factory_contract_id: existing?.factory_contract_id,
    token_contract_id: existing?.token_contract_id,
    recipient: existing?.recipient,
    lifecycle_state: existing?.lifecycle_state ?? "open",
    opened_tx_hash: existing?.opened_tx_hash,
    last_topup_tx_hash: existing?.last_topup_tx_hash,
    last_settle_tx_hash: existing?.last_settle_tx_hash,
    close_start_tx_hash: existing?.close_start_tx_hash,
    close_tx_hash: existing?.close_tx_hash,
    refund_tx_hash: existing?.refund_tx_hash,
    updated_at: new Date().toISOString(),
  });
}
