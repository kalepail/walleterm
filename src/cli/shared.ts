import { Keypair } from "@stellar/stellar-sdk";
import { resolveMppStatePath } from "../mpp-channel.js";
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

export function resolveMppChannelStatePath(configPath: string, config: WalletermConfig): string {
  return resolveMppStatePath(configPath, config.payments?.mpp?.channel);
}
