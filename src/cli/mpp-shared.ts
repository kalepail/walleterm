import { Keypair } from "@stellar/stellar-sdk";
import {
  resolveMppStatePath,
  resolveStoredChannel,
  type StoredMppChannel,
} from "../mpp-channel.js";
import type { WalletermConfig } from "../config.js";
import { isSshAgentRef, type SecretResolver } from "../secrets.js";

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

export function assertSeedBackedMppSecretRef(secretRef: string, context: string): void {
  if (isSshAgentRef(secretRef)) {
    throw new Error(
      `${context} currently requires a seed-backed secret ref. ssh-agent:// refs are not supported for MPP channel lifecycle commands.`,
    );
  }
}

export async function resolveSeedBackedMppKeypair(
  resolver: SecretResolver,
  secretRef: string,
  context: string,
): Promise<Keypair> {
  assertSeedBackedMppSecretRef(secretRef, context);
  const secret = await resolver.resolve(secretRef);
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error(`${context} secret ref must resolve to a valid Stellar secret seed (S...)`);
  }
}
