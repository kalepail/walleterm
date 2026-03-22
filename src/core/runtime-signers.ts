import { Keypair } from "@stellar/stellar-sdk";
import { isSshAgentRef, SecretResolver } from "../secrets.js";
import { type Signer, KeypairSigner, createSshAgentSigner } from "../signer.js";
import type {
  AccountRef,
  DelegatedSignerConfig,
  ExternalSignerConfig,
  RuntimeDelegatedSigner,
  RuntimeExternalSigner,
  RuntimeSigners,
  SignerConfigSummary,
} from "./types.js";

function emptyRuntimeSigners(): RuntimeSigners {
  return {
    external: [],
    delegated: [],
    externalByComposite: new Map(),
    delegatedByAddress: new Map(),
    byAddress: new Map(),
    allSigners: [],
  };
}

export function compositeExternalKey(verifierContractId: string, publicKeyHex: string): string {
  return `${verifierContractId}|${publicKeyHex.toLowerCase()}`;
}

export function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

function assertSeed(secret: string, label: string): Keypair {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new Error(`${label} must resolve to a valid Stellar secret seed (S...)`);
  }
  return keypair;
}

function loadExternalSigner(row: ExternalSignerConfig, signer: Signer): RuntimeExternalSigner {
  const actualHex = signer.rawPublicKey().toString("hex");
  const expectedHex = normalizeHex(row.public_key_hex);
  if (actualHex !== expectedHex) {
    throw new Error(
      `External signer '${row.name}' public key mismatch: expected ${expectedHex}, got ${actualHex}`,
    );
  }

  return {
    kind: "external",
    name: row.name,
    verifierContractId: row.verifier_contract_id,
    publicKeyHex: expectedHex,
    signer,
  };
}

function loadDelegatedSigner(row: DelegatedSignerConfig, signer: Signer): RuntimeDelegatedSigner {
  const derived = signer.publicKey();
  if (derived !== row.address) {
    throw new Error(
      `Delegated signer '${row.name}' address mismatch: expected ${row.address}, got ${derived}`,
    );
  }

  return {
    kind: "delegated",
    name: row.name,
    address: row.address,
    signer,
  };
}

async function resolveSignerFromRef(
  ref: string,
  label: string,
  resolver: SecretResolver,
): Promise<Signer> {
  if (isSshAgentRef(ref)) {
    return createSshAgentSigner(ref);
  }
  const seed = await resolver.resolve(ref);
  const keypair = assertSeed(seed, label);
  return new KeypairSigner(keypair);
}

export async function loadRuntimeSigners(
  accountRef: AccountRef | null,
  resolver: SecretResolver,
): Promise<RuntimeSigners> {
  if (!accountRef) {
    return emptyRuntimeSigners();
  }

  const { alias, account } = accountRef;
  const external: RuntimeExternalSigner[] = [];
  const delegated: RuntimeDelegatedSigner[] = [];

  for (const row of account.external_signers ?? []) {
    if (!row.enabled) continue;
    const signer = await resolveSignerFromRef(
      row.secret_ref,
      `External signer '${row.name}' in account '${alias}'`,
      resolver,
    );
    external.push(loadExternalSigner(row, signer));
  }

  for (const row of account.delegated_signers ?? []) {
    if (!row.enabled) continue;
    const signer = await resolveSignerFromRef(
      row.secret_ref,
      `Delegated signer '${row.name}' in account '${alias}'`,
      resolver,
    );
    delegated.push(loadDelegatedSigner(row, signer));
  }

  const externalByComposite = new Map<string, RuntimeExternalSigner>();
  const delegatedByAddress = new Map<string, RuntimeDelegatedSigner>();
  const byAddress = new Map<string, Signer>();

  for (const signer of external) {
    externalByComposite.set(
      compositeExternalKey(signer.verifierContractId, signer.publicKeyHex),
      signer,
    );
    byAddress.set(signer.signer.publicKey(), signer.signer);
  }

  for (const signer of delegated) {
    delegatedByAddress.set(signer.address, signer);
    byAddress.set(signer.address, signer.signer);
  }

  return {
    external,
    delegated,
    externalByComposite,
    delegatedByAddress,
    byAddress,
    allSigners: [...byAddress.values()],
  };
}

export function listSignerConfig(accountRef: AccountRef): SignerConfigSummary {
  return {
    account: accountRef.alias,
    external: (accountRef.account.external_signers ?? [])
      .filter((row) => row.enabled !== false)
      .map((row) => ({
        name: row.name,
        verifier_contract_id: row.verifier_contract_id,
        public_key_hex: normalizeHex(row.public_key_hex),
        secret_ref: row.secret_ref,
      })),
    delegated: (accountRef.account.delegated_signers ?? [])
      .filter((row) => row.enabled !== false)
      .map((row) => ({
        name: row.name,
        address: row.address,
        secret_ref: row.secret_ref,
      })),
  };
}
