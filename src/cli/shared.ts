import { Keypair } from "@stellar/stellar-sdk";
import {
  resolveMppStatePath,
  resolveStoredChannel,
  type StoredMppChannel,
} from "../mpp-channel.js";
import type { WalletermConfig } from "../config.js";

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value '${value}'`);
  }
  return parsed;
}

export function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function requireNonNegativeInt(value: number | undefined, label: string): number {
  if (value === undefined || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function parseBigIntAmount(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer string`);
  }
}

export function credentialIdFromKeypair(keypair: Keypair): string {
  return Buffer.from(keypair.rawPublicKey()).toString("hex");
}

export function buildKeypairJson(keypair: Keypair): Record<string, string> {
  return {
    secret_seed: keypair.secret(),
    public_key: keypair.publicKey(),
    public_key_hex: credentialIdFromKeypair(keypair),
  };
}

export function resolveMppFunderSecretRef(
  config: WalletermConfig,
  explicit?: string,
): string | undefined {
  return explicit ?? config.payments?.mpp?.default_payer_secret_ref;
}

export function resolveMppRecipientSecretRef(
  config: WalletermConfig,
  explicit?: string,
): string | undefined {
  return explicit ?? config.payments?.mpp?.channel?.recipient_secret_ref;
}

export function resolveMppChannelStatePath(configPath: string, config: WalletermConfig): string {
  return resolveMppStatePath(configPath, config.payments?.mpp?.channel);
}

export function resolveMppChannelRecord(
  configPath: string,
  config: WalletermConfig,
  networkName: string,
  explicitChannelId?: string,
): StoredMppChannel | null {
  const statePath = resolveMppChannelStatePath(configPath, config);
  const configuredDefault = config.payments?.mpp?.channel?.default_channel_contract_id;
  return resolveStoredChannel(statePath, networkName, explicitChannelId ?? configuredDefault);
}

export function requireMppChannelRecord(
  configPath: string,
  config: WalletermConfig,
  networkName: string,
  explicitChannelId?: string,
): StoredMppChannel {
  const record = resolveMppChannelRecord(configPath, config, networkName, explicitChannelId);
  if (!record) {
    throw new Error(
      "No MPP channel selected. Pass --channel-id, configure payments.mpp.channel.default_channel_contract_id, or open a channel first.",
    );
  }
  return record;
}

export function assertMppChannelRole(
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
