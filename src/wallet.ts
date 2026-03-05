import { randomBytes } from "node:crypto";
import {
  Account,
  Address,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./config.js";

export interface IndexerContractSummary {
  contract_id: string;
  context_rule_count: number;
  external_signer_count: number;
  delegated_signer_count: number;
  native_signer_count: number;
  first_seen_ledger: number;
  last_seen_ledger: number;
  context_rule_ids: number[];
}

export interface AddressLookupResponse {
  signerAddress: string;
  contracts: IndexerContractSummary[];
  count: number;
}

export interface ContractSignerRow {
  context_rule_id: number;
  signer_type: "External" | "Delegated" | "Native";
  signer_address: string | null;
  credential_id: string | null;
}

export interface ContractSignersResponse {
  contractId: string;
  signers: ContractSignerRow[];
}

export interface AuthBundleInput {
  kind: "bundle";
  func: string;
  auth: xdr.SorobanAuthorizationEntry[];
}

const DEFAULT_INDEXER_BY_PASSPHRASE: Record<string, string> = {
  "Test SDF Network ; September 2015": "https://smart-account-indexer.sdf-ecosystem.workers.dev",
  "Public Global Stellar Network ; September 2015":
    "https://smart-account-indexer-mainnet.sdf-ecosystem.workers.dev",
};

const SMART_ACCOUNT_KIT_DEPLOYER_SEED_LABEL = "openzeppelin-smart-account-kit";

function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

export function smartAccountKitDeployerKeypair(): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(SMART_ACCOUNT_KIT_DEPLOYER_SEED_LABEL)));
}

export function deriveSaltHexFromRawString(raw: string): string {
  return hash(Buffer.from(raw)).toString("hex");
}

function assertPubkeyHex(publicKeyHex: string): string {
  const normalized = normalizeHex(publicKeyHex);
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== 64) {
    throw new Error("public_key_hex must be a 32-byte hex string");
  }
  return normalized;
}

function randomNonceInt64(): xdr.Int64 {
  const raw = randomBytes(8);
  const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
  return xdr.Int64.fromString(value.toString());
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Indexer request failed (${response.status}): ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveIndexerUrl(network: NetworkConfig, override?: string): string {
  if (override) return override;
  if (network.indexer_url) return network.indexer_url;
  const byPassphrase = DEFAULT_INDEXER_BY_PASSPHRASE[network.network_passphrase];
  if (byPassphrase) return byPassphrase;
  throw new Error(
    "No indexer URL configured. Set networks.<name>.indexer_url or pass --indexer-url.",
  );
}

export async function discoverContractsByAddress(
  indexerUrl: string,
  address: string,
): Promise<AddressLookupResponse> {
  return fetchJson<AddressLookupResponse>(
    `${indexerUrl.replace(/\/$/, "")}/api/lookup/address/${encodeURIComponent(address)}`,
  );
}

export async function listContractSigners(
  indexerUrl: string,
  contractId: string,
): Promise<ContractSignersResponse> {
  return fetchJson<ContractSignersResponse>(
    `${indexerUrl.replace(/\/$/, "")}/api/contract/${encodeURIComponent(contractId)}/signers`,
  );
}

export function makeDelegatedSignerScVal(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

export function makeExternalSignerScVal(
  verifierContractId: string,
  publicKeyHex: string,
): xdr.ScVal {
  const normalized = assertPubkeyHex(publicKeyHex);
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierContractId).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(normalized, "hex")),
  ]);
}

function makeInvocation(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName,
        args,
      }),
    ),
    subInvocations: [],
  });
}

function makeInvokeHostFunctionXdr(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
): string {
  const host = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
      functionName,
      args,
    }),
  );
  return host.toXDR("base64");
}

export function buildSignerMutationBundle(
  contractId: string,
  functionName: "add_signer" | "remove_signer",
  contextRuleId: number,
  signerScVal: xdr.ScVal,
  expirationLedger: number,
): AuthBundleInput {
  const args = [xdr.ScVal.scvU32(contextRuleId), signerScVal];
  const invocation = makeInvocation(contractId, functionName, args);

  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(contractId).toScAddress(),
        nonce: randomNonceInt64(),
        signatureExpirationLedger: expirationLedger,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });

  return {
    kind: "bundle",
    func: makeInvokeHostFunctionXdr(contractId, functionName, args),
    auth: [entry],
  };
}

export function deriveContractIdFromSalt(
  networkPassphrase: string,
  deployerPublicKey: string,
  salt: Buffer,
): string {
  if (salt.length !== 32) {
    throw new Error("salt must be 32 bytes");
  }

  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployerPublicKey).toScAddress(),
          salt,
        }),
      ),
    }),
  );

  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export interface CreateWalletTxOptions {
  network: NetworkConfig;
  deployer: Keypair;
  wasmHashHex: string;
  signers: xdr.ScVal[];
  saltHex?: string;
  sequenceOverride?: string;
  fee?: string;
  timeoutSeconds?: number;
  skipPrepare?: boolean;
}

function parseSalt(saltHex?: string): Buffer {
  if (!saltHex) return randomBytes(32);
  const normalized = normalizeHex(saltHex);
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== 64) {
    throw new Error("salt-hex must be a 32-byte hex string");
  }
  return Buffer.from(normalized, "hex");
}

function parseWasmHash(wasmHashHex: string): Buffer {
  const normalized = normalizeHex(wasmHashHex);
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== 64) {
    throw new Error("wasm-hash must be a 32-byte hex string");
  }
  return Buffer.from(normalized, "hex");
}

async function resolveSourceAccount(
  network: NetworkConfig,
  deployerPublicKey: string,
  sequenceOverride?: string,
): Promise<Account> {
  if (sequenceOverride !== undefined) {
    if (!/^[0-9]+$/.test(sequenceOverride)) {
      throw new Error("sequence must be an integer string");
    }
    return new Account(deployerPublicKey, sequenceOverride);
  }

  const server = new rpc.Server(network.rpc_url);
  return server.getAccount(deployerPublicKey);
}

function normalizePreparedSorobanFeeToResourceOnly(tx: Transaction): Transaction {
  try {
    const envelope = tx.toEnvelope();
    if (envelope.switch().name !== "envelopeTypeTx") return tx;

    const v1 = envelope.v1().tx();
    const sorobanData = v1.ext().sorobanData();
    const resourceFee = sorobanData.resourceFee().toString();
    if (v1.fee().toString() === resourceFee) return tx;

    return TransactionBuilder.cloneFrom(tx, {
      fee: "0",
      sorobanData,
    }).build();
  } catch {
    return tx;
  }
}

export async function createWalletDeployTx(
  options: CreateWalletTxOptions,
): Promise<{ contractId: string; txXdr: string; saltHex: string }> {
  if (options.signers.length === 0) {
    throw new Error("At least one signer is required for wallet creation");
  }

  const wasmHash = parseWasmHash(options.wasmHashHex);
  const salt = parseSalt(options.saltHex);
  const account = await resolveSourceAccount(
    options.network,
    options.deployer.publicKey(),
    options.sequenceOverride,
  );

  const op = Operation.createCustomContract({
    address: Address.fromString(options.deployer.publicKey()),
    wasmHash,
    salt,
    constructorArgs: [xdr.ScVal.scvVec(options.signers), xdr.ScVal.scvMap([])],
  });

  let tx: Transaction = new TransactionBuilder(account, {
    // Keep base fee configurable; for default flow we normalize prepared Soroban
    // txs to fee == resourceFee so Channels accepts wallet deployment txs.
    fee: options.fee ?? "0",
    networkPassphrase: options.network.network_passphrase,
  })
    .addOperation(op)
    // Channels currently rejects envelopes whose maxTime is more than 60s ahead.
    .setTimeout(options.timeoutSeconds ?? 60)
    .build();

  if (!options.skipPrepare) {
    tx = await new rpc.Server(options.network.rpc_url).prepareTransaction(tx);
    if (options.fee === undefined || options.fee === "0") {
      tx = normalizePreparedSorobanFeeToResourceOnly(tx);
    }
  }

  tx.sign(options.deployer);

  return {
    contractId: deriveContractIdFromSalt(
      options.network.network_passphrase,
      options.deployer.publicKey(),
      salt,
    ),
    txXdr: tx.toXDR(),
    saltHex: salt.toString("hex"),
  };
}
