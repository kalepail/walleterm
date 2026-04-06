import { Keypair } from "@stellar/stellar-sdk";

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(`Invalid integer value '${value}'`);
  }
  const parsed = Number(value);
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
