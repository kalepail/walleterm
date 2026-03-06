import { readFileSync, writeFileSync } from "node:fs";
import { Address, Keypair, TransactionBuilder, hash, rpc, xdr } from "@stellar/stellar-sdk";
import type {
  NetworkConfig,
  SmartAccountConfig,
  WalletermConfig,
  ExternalSignerConfig,
  DelegatedSignerConfig,
} from "./config.js";
import { findAccountByContractId, resolveAccount } from "./config.js";
import { SecretResolver } from "./secrets.js";

export interface RuntimeExternalSigner {
  kind: "external";
  name: string;
  verifierContractId: string;
  publicKeyHex: string;
  keypair: Keypair;
}

export interface RuntimeDelegatedSigner {
  kind: "delegated";
  name: string;
  address: string;
  keypair: Keypair;
}

export interface RuntimeSigners {
  external: RuntimeExternalSigner[];
  delegated: RuntimeDelegatedSigner[];
  externalByComposite: Map<string, RuntimeExternalSigner>;
  delegatedByAddress: Map<string, RuntimeDelegatedSigner>;
  byAddress: Map<string, Keypair>;
  allKeypairs: Keypair[];
}

export interface SignDetail {
  target: string;
  action: "signed" | "skipped";
  reason: string;
}

export interface SignReport {
  kind: string;
  summary: {
    signed: number;
    skipped: number;
  };
  details: SignDetail[];
}

export type ParsedInput =
  | {
      kind: "tx";
      envelope: xdr.TransactionEnvelope;
    }
  | {
      kind: "auth";
      auth: xdr.SorobanAuthorizationEntry[];
    }
  | {
      kind: "bundle";
      func?: string;
      auth: xdr.SorobanAuthorizationEntry[];
    };

export interface SignContext {
  config: WalletermConfig;
  networkName: string;
  network: NetworkConfig;
  accountRef: { alias: string; account: SmartAccountConfig } | null;
  runtimeSigners: RuntimeSigners;
  expirationLedger: number;
}

function createReport(kind: string): SignReport {
  return {
    kind,
    summary: { signed: 0, skipped: 0 },
    details: [],
  };
}

function reportSigned(report: SignReport, target: string, reason: string): void {
  report.summary.signed += 1;
  report.details.push({ target, action: "signed", reason });
}

function reportSkipped(report: SignReport, target: string, reason: string): void {
  report.summary.skipped += 1;
  report.details.push({ target, action: "skipped", reason });
}

function compositeExternalKey(verifierContractId: string, publicKeyHex: string): string {
  return `${verifierContractId}|${publicKeyHex.toLowerCase()}`;
}

function normalizeHex(hex: string): string {
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

function loadExternalSigner(
  row: ExternalSignerConfig,
  secret: string,
  accountAlias: string,
): RuntimeExternalSigner {
  const keypair = assertSeed(secret, `External signer '${row.name}' in account '${accountAlias}'`);
  const actualHex = Buffer.from(keypair.rawPublicKey()).toString("hex");
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
    keypair,
  };
}

function loadDelegatedSigner(
  row: DelegatedSignerConfig,
  secret: string,
  accountAlias: string,
): RuntimeDelegatedSigner {
  const keypair = assertSeed(secret, `Delegated signer '${row.name}' in account '${accountAlias}'`);
  const derived = keypair.publicKey();
  if (derived !== row.address) {
    throw new Error(
      `Delegated signer '${row.name}' address mismatch: expected ${row.address}, got ${derived}`,
    );
  }

  return {
    kind: "delegated",
    name: row.name,
    address: row.address,
    keypair,
  };
}

export async function loadRuntimeSigners(
  accountRef: { alias: string; account: SmartAccountConfig } | null,
  resolver: SecretResolver,
): Promise<RuntimeSigners> {
  if (!accountRef) {
    return {
      external: [],
      delegated: [],
      externalByComposite: new Map(),
      delegatedByAddress: new Map(),
      byAddress: new Map(),
      allKeypairs: [],
    };
  }

  const { alias, account } = accountRef;
  const external: RuntimeExternalSigner[] = [];
  const delegated: RuntimeDelegatedSigner[] = [];

  for (const row of account.external_signers ?? []) {
    if (!row.enabled) continue;
    const seed = await resolver.resolve(row.secret_ref);
    external.push(loadExternalSigner(row, seed, alias));
  }

  for (const row of account.delegated_signers ?? []) {
    if (!row.enabled) continue;
    const seed = await resolver.resolve(row.secret_ref);
    delegated.push(loadDelegatedSigner(row, seed, alias));
  }

  const externalByComposite = new Map<string, RuntimeExternalSigner>();
  const delegatedByAddress = new Map<string, RuntimeDelegatedSigner>();
  const byAddress = new Map<string, Keypair>();

  for (const signer of external) {
    externalByComposite.set(
      compositeExternalKey(signer.verifierContractId, signer.publicKeyHex),
      signer,
    );
    byAddress.set(signer.keypair.publicKey(), signer.keypair);
  }

  for (const signer of delegated) {
    delegatedByAddress.set(signer.address, signer);
    byAddress.set(signer.address, signer.keypair);
  }

  const allKeypairs = [...byAddress.values()];

  return {
    external,
    delegated,
    externalByComposite,
    delegatedByAddress,
    byAddress,
    allKeypairs,
  };
}

export function listSignerConfig(accountRef: { alias: string; account: SmartAccountConfig }): {
  account: string;
  external: Array<{
    name: string;
    verifier_contract_id: string;
    public_key_hex: string;
    secret_ref: string;
  }>;
  delegated: Array<{ name: string; address: string; secret_ref: string }>;
} {
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

function parseTxEnvelope(raw: string): xdr.TransactionEnvelope | null {
  try {
    return xdr.TransactionEnvelope.fromXDR(raw, "base64");
  } catch {
    return null;
  }
}

function parseAuthEntry(raw: string): xdr.SorobanAuthorizationEntry | null {
  try {
    return xdr.SorobanAuthorizationEntry.fromXDR(raw, "base64");
  } catch {
    return null;
  }
}

export function parseInputFile(path: string): ParsedInput {
  const content = readFileSync(path, "utf8").trim();

  const tx = parseTxEnvelope(content);
  if (tx) {
    return { kind: "tx", envelope: tx };
  }

  const auth = parseAuthEntry(content);
  if (auth) {
    return { kind: "auth", auth: [auth] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new Error(`Input '${path}' is neither base64 XDR nor JSON`);
  }

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new Error(`Input JSON in '${path}' must be an object`);
  }

  const obj = parsedJson as Record<string, unknown>;

  if (typeof obj.xdr === "string") {
    const txEnvelope = parseTxEnvelope(obj.xdr);
    if (txEnvelope) {
      return { kind: "tx", envelope: txEnvelope };
    }
    const entry = parseAuthEntry(obj.xdr);
    if (entry) {
      return { kind: "auth", auth: [entry] };
    }
    throw new Error("JSON field 'xdr' is not a recognized transaction/auth XDR");
  }

  if (Array.isArray(obj.auth)) {
    const authEntries = obj.auth.map((value, index) => {
      if (typeof value !== "string") {
        throw new Error(`bundle.auth[${index}] must be a base64 XDR string`);
      }
      const entry = parseAuthEntry(value);
      if (!entry) {
        throw new Error(`bundle.auth[${index}] is not a valid SorobanAuthorizationEntry XDR`);
      }
      return entry;
    });

    return {
      kind: "bundle",
      func: typeof obj.func === "string" ? obj.func : undefined,
      auth: authEntries,
    };
  }

  throw new Error("Unsupported input JSON format. Use {xdr} or {func,auth[]}.");
}

function withExpiration(
  entry: xdr.SorobanAuthorizationEntry,
  expirationLedger: number,
): xdr.SorobanAuthorizationEntry {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const creds = clone.credentials();
  if (creds.switch().name === "sorobanCredentialsAddress") {
    creds.address().signatureExpirationLedger(expirationLedger);
  }
  return clone;
}

function authorizationPayload(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): Buffer {
  const creds = entry.credentials().address();
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: creds.nonce(),
      signatureExpirationLedger: creds.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    }),
  );

  return hash(preimage.toXDR());
}

function makeAddressSignatureScVal(publicKey: string, signature: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(Address.fromString(publicKey).toScAddress().accountId().ed25519()),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(signature),
      }),
    ]),
  ]);
}

function makeSignerKeyExternal(verifierContractId: string, publicKeyHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierContractId).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
  ]);
}

function makeSignerKeyDelegated(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

type DecodedSignerKey =
  | { type: "external"; verifierContractId: string; publicKeyHex: string }
  | { type: "delegated"; address: string }
  | null;

function decodeSignerKey(key: xdr.ScVal): DecodedSignerKey {
  if (key.switch().name !== "scvVec") return null;
  const parts = key.vec()!;
  if (parts.length < 2) return null;

  if (parts[0]!.switch().name !== "scvSymbol") return null;
  const tag = parts[0]!.sym().toString();

  if (tag === "Delegated") {
    if (parts[1]!.switch().name !== "scvAddress") return null;
    return {
      type: "delegated",
      address: Address.fromScAddress(parts[1]!.address()).toString(),
    };
  }

  if (tag === "External") {
    if (parts.length < 3) return null;
    if (parts[1]!.switch().name !== "scvAddress" || parts[2]!.switch().name !== "scvBytes")
      return null;
    return {
      type: "external",
      verifierContractId: Address.fromScAddress(parts[1]!.address()).toString(),
      publicKeyHex: Buffer.from(parts[2]!.bytes()).toString("hex"),
    };
  }

  return null;
}

function ensureSignatureMap(credentials: xdr.SorobanAddressCredentials): xdr.ScMapEntry[] {
  const signature = credentials.signature();

  if (signature.switch().name === "scvVoid") {
    credentials.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]));
    return credentials.signature().vec()![0]!.map()!;
  }

  if (signature.switch().name !== "scvVec") {
    throw new Error("Unsupported signature ScVal shape for smart-account entry");
  }

  const vec = signature.vec()!;
  if (vec.length === 0 || vec[0]!.switch().name !== "scvMap") {
    throw new Error("Unsupported signature ScVal shape for smart-account entry");
  }

  return vec[0]!.map()!;
}

function sortMapEntries(entries: xdr.ScMapEntry[]): void {
  entries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));
}

function randomNonceInt64(): xdr.Int64 {
  const raw = Buffer.from(hash(Buffer.from(String(Date.now() + Math.random())))).subarray(0, 8);
  const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
  return xdr.Int64.fromString(value.toString());
}

function createDelegatedAuthEntry(
  contractId: string,
  delegated: RuntimeDelegatedSigner,
  signaturePayload: Buffer,
  expirationLedger: number,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry {
  const delegatedInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: "__check_auth",
        args: [xdr.ScVal.scvBytes(signaturePayload)],
      }),
    ),
    subInvocations: [],
  });

  const nonce = randomNonceInt64();
  const delegatedPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce,
      signatureExpirationLedger: expirationLedger,
      invocation: delegatedInvocation,
    }),
  );

  const delegatedPayload = hash(delegatedPreimage.toXDR());
  const signature = Buffer.from(delegated.keypair.sign(delegatedPayload));

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(delegated.address).toScAddress(),
        nonce,
        signatureExpirationLedger: expirationLedger,
        signature: makeAddressSignatureScVal(delegated.address, signature),
      }),
    ),
    rootInvocation: delegatedInvocation,
  });
}

function selectAccountForAddress(
  context: SignContext,
  address: string,
): { alias: string; account: SmartAccountConfig } | null {
  if (context.accountRef && context.accountRef.account.contract_id === address) {
    return context.accountRef;
  }

  return findAccountByContractId(context.config, context.networkName, address);
}

function signGenericAddressEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: Keypair,
  report: SignReport,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry {
  const payload = authorizationPayload(entry, networkPassphrase);
  const signature = Buffer.from(signer.sign(payload));
  entry.credentials().address().signature(makeAddressSignatureScVal(signer.publicKey(), signature));
  reportSigned(report, `auth:${signer.publicKey()}`, "signed address auth entry");
  return entry;
}

function appendMissingSmartAccountEntries(
  sigMap: xdr.ScMapEntry[],
  runtimeSigners: RuntimeSigners,
): void {
  for (const external of runtimeSigners.external) {
    sigMap.push(
      new xdr.ScMapEntry({
        key: makeSignerKeyExternal(external.verifierContractId, external.publicKeyHex),
        val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
      }),
    );
  }

  for (const delegated of runtimeSigners.delegated) {
    sigMap.push(
      new xdr.ScMapEntry({
        key: makeSignerKeyDelegated(delegated.address),
        val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
      }),
    );
  }

  sortMapEntries(sigMap);
}

function signSmartAccountEntry(
  entry: xdr.SorobanAuthorizationEntry,
  accountRef: { alias: string; account: SmartAccountConfig },
  runtimeSigners: RuntimeSigners,
  report: SignReport,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry[] {
  const payload = authorizationPayload(entry, networkPassphrase);
  const creds = entry.credentials().address();
  const sigMap = ensureSignatureMap(creds);

  if (sigMap.length === 0) {
    appendMissingSmartAccountEntries(sigMap, runtimeSigners);
  }

  const delegatedToExpand = new Map<string, RuntimeDelegatedSigner>();

  for (const item of sigMap) {
    const decoded = decodeSignerKey(item.key());
    if (!decoded) {
      reportSkipped(report, `auth:${accountRef.alias}`, "unrecognized signer key in signature map");
      continue;
    }

    if (decoded.type === "external") {
      const composite = compositeExternalKey(decoded.verifierContractId, decoded.publicKeyHex);
      const signer = runtimeSigners.externalByComposite.get(composite);
      if (!signer) {
        reportSkipped(
          report,
          `auth:${accountRef.alias}`,
          `no local key for external signer ${decoded.verifierContractId}:${decoded.publicKeyHex}`,
        );
        continue;
      }

      const signature = Buffer.from(signer.keypair.sign(payload));
      item.val(xdr.ScVal.scvBytes(signature));
      reportSigned(report, `auth:${accountRef.alias}`, `signed external signer ${signer.name}`);
      continue;
    }

    const delegated = runtimeSigners.delegatedByAddress.get(decoded.address);
    if (!delegated) {
      reportSkipped(
        report,
        `auth:${accountRef.alias}`,
        `no local key for delegated signer ${decoded.address}`,
      );
      continue;
    }

    item.val(xdr.ScVal.scvBytes(Buffer.alloc(0)));
    delegatedToExpand.set(delegated.address, delegated);
    reportSigned(
      report,
      `auth:${accountRef.alias}`,
      `added delegated marker for ${delegated.name}`,
    );
  }

  sortMapEntries(sigMap);
  creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap(sigMap)]));

  const extraEntries: xdr.SorobanAuthorizationEntry[] = [entry];

  for (const delegated of delegatedToExpand.values()) {
    extraEntries.push(
      createDelegatedAuthEntry(
        accountRef.account.contract_id,
        delegated,
        payload,
        creds.signatureExpirationLedger(),
        networkPassphrase,
      ),
    );
    reportSigned(
      report,
      `auth:${accountRef.alias}`,
      `generated delegated auth entry for ${delegated.name}`,
    );
  }

  return extraEntries;
}

function signOneAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: SignContext,
  report: SignReport,
): xdr.SorobanAuthorizationEntry[] {
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") {
    reportSkipped(report, "auth", "unsupported credential type");
    return [entry];
  }

  const addressCreds = entry.credentials().address();
  const authAddress = Address.fromScAddress(addressCreds.address()).toString();

  if (authAddress.startsWith("G")) {
    const signer = context.runtimeSigners.byAddress.get(authAddress);
    if (!signer) {
      reportSkipped(report, `auth:${authAddress}`, "no local key for address");
      return [entry];
    }

    return [signGenericAddressEntry(entry, signer, report, context.network.network_passphrase)];
  }

  if (authAddress.startsWith("C")) {
    const accountRef = selectAccountForAddress(context, authAddress);
    if (!accountRef) {
      reportSkipped(
        report,
        `auth:${authAddress}`,
        "no matching smart account config for contract address",
      );
      return [entry];
    }

    return signSmartAccountEntry(
      entry,
      accountRef,
      context.runtimeSigners,
      report,
      context.network.network_passphrase,
    );
  }

  reportSkipped(report, `auth:${authAddress}`, "unsupported address format");
  return [entry];
}

function signAuthList(
  entries: xdr.SorobanAuthorizationEntry[],
  context: SignContext,
  report: SignReport,
): xdr.SorobanAuthorizationEntry[] {
  const signed: xdr.SorobanAuthorizationEntry[] = [];

  for (const entry of entries) {
    const withTtl = withExpiration(entry, context.expirationLedger);
    const out = signOneAuthEntry(withTtl, context, report);
    signed.push(...out);
  }

  return signed;
}

function getEnvelopeOperations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  const type = envelope.switch().name;
  if (type === "envelopeTypeTx") {
    return envelope.v1().tx().operations();
  }

  if (type === "envelopeTypeTxFeeBump") {
    const inner = envelope.feeBump().tx().innerTx();
    return inner.v1().tx().operations();
  }

  return [];
}

function collectSigningAddresses(tx: unknown): Set<string> {
  const addresses = new Set<string>();
  const value = tx as Record<string, unknown>;

  const addMaybe = (addr: unknown): void => {
    if (typeof addr === "string" && addr) addresses.add(addr);
  };

  addMaybe(value.source);

  const ops = value.operations;
  if (Array.isArray(ops)) {
    for (const op of ops) {
      const source = (op as Record<string, unknown>).source;
      addMaybe(source);
    }
  }

  const inner = value.innerTransaction as Record<string, unknown> | undefined;
  if (inner) {
    addMaybe(inner.source);
    const innerOps = inner.operations;
    if (Array.isArray(innerOps)) {
      for (const op of innerOps) {
        addMaybe((op as Record<string, unknown>).source);
      }
    }
  }

  return addresses;
}

function signEnvelopeSignatures(
  envelopeXdr: string,
  context: SignContext,
  report: SignReport,
): string {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, context.network.network_passphrase);
  const signingAddresses = collectSigningAddresses(tx);

  for (const keypair of context.runtimeSigners.allKeypairs) {
    if (!signingAddresses.has(keypair.publicKey())) {
      continue;
    }

    tx.sign(keypair);
    reportSigned(report, `tx:${keypair.publicKey()}`, "added envelope signature");
  }

  return tx.toXDR();
}

function signTransactionInput(
  parsed: ParsedInput & { kind: "tx" },
  context: SignContext,
): {
  out: string;
  report: SignReport;
} {
  const report = createReport("tx");
  const envelope = xdr.TransactionEnvelope.fromXDR(parsed.envelope.toXDR());

  const operations = getEnvelopeOperations(envelope);
  for (const op of operations) {
    if (op.body().switch().name !== "invokeHostFunction") {
      continue;
    }

    const invoke = op.body().invokeHostFunctionOp();
    const authEntries = invoke.auth();
    const signedAuth = signAuthList(authEntries, context, report);
    invoke.auth(signedAuth);
  }

  const signedEnvelopeXdr = signEnvelopeSignatures(envelope.toXDR("base64"), context, report);
  return { out: signedEnvelopeXdr, report };
}

function signAuthInput(
  parsed: ParsedInput & { kind: "auth" },
  context: SignContext,
): {
  out: string;
  report: SignReport;
} {
  const report = createReport("auth");
  const signed = signAuthList(parsed.auth, context, report);

  if (signed.length === 1) {
    return { out: signed[0]!.toXDR("base64"), report };
  }

  return {
    out: JSON.stringify({ auth: signed.map((entry) => entry.toXDR("base64")) }, null, 2),
    report,
  };
}

function signBundleInput(
  parsed: ParsedInput & { kind: "bundle" },
  context: SignContext,
): {
  out: string;
  report: SignReport;
} {
  const report = createReport("bundle");
  const signed = signAuthList(parsed.auth, context, report);

  return {
    out: JSON.stringify(
      {
        ...(parsed.func ? { func: parsed.func } : {}),
        auth: signed.map((entry) => entry.toXDR("base64")),
      },
      null,
      2,
    ),
    report,
  };
}

export function inspectInput(parsed: ParsedInput): Record<string, unknown> {
  if (parsed.kind === "tx") {
    const operations = getEnvelopeOperations(parsed.envelope);
    let authEntries = 0;
    for (const op of operations) {
      if (op.body().switch().name === "invokeHostFunction") {
        authEntries += op.body().invokeHostFunctionOp().auth().length;
      }
    }

    return {
      kind: "tx",
      envelopeType: parsed.envelope.switch().name,
      operations: operations.length,
      authEntries,
    };
  }

  const authSummaries = parsed.auth.map((entry, index) => {
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") {
      return { index, credentialType: creds.switch().name };
    }
    const addressCreds = creds.address();
    const address = Address.fromScAddress(addressCreds.address()).toString();
    return {
      index,
      credentialType: "sorobanCredentialsAddress",
      address,
      nonce: addressCreds.nonce().toString(),
      signatureExpirationLedger: addressCreds.signatureExpirationLedger(),
    };
  });

  return {
    kind: parsed.kind,
    authEntries: authSummaries,
    hasFunc: parsed.kind === "bundle" ? Boolean(parsed.func) : undefined,
  };
}

function canSignAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: SignContext,
): { signable: boolean; reason: string } {
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") {
    return { signable: false, reason: "unsupported credential type" };
  }

  const creds = entry.credentials().address();
  const address = Address.fromScAddress(creds.address()).toString();

  if (address.startsWith("G")) {
    const ok = context.runtimeSigners.byAddress.has(address);
    return {
      signable: ok,
      reason: ok ? "matching local address signer" : "no local signer for address",
    };
  }

  if (address.startsWith("C")) {
    const accountRef = selectAccountForAddress(context, address);
    if (!accountRef) {
      return { signable: false, reason: "no smart-account config for contract" };
    }

    try {
      const sigMap = ensureSignatureMap(
        withExpiration(entry, context.expirationLedger).credentials().address(),
      );
      if (sigMap.length === 0) {
        const anyLocal =
          context.runtimeSigners.external.length > 0 || context.runtimeSigners.delegated.length > 0;
        return {
          signable: anyLocal,
          reason: anyLocal ? "will synthesize signer map entries from config" : "no local signers",
        };
      }

      for (const item of sigMap) {
        const decoded = decodeSignerKey(item.key());
        if (!decoded) continue;
        if (decoded.type === "external") {
          const composite = compositeExternalKey(decoded.verifierContractId, decoded.publicKeyHex);
          if (context.runtimeSigners.externalByComposite.has(composite)) {
            return { signable: true, reason: "matching external signer key" };
          }
        } else if (context.runtimeSigners.delegatedByAddress.has(decoded.address)) {
          return { signable: true, reason: "matching delegated signer key" };
        }
      }

      return { signable: false, reason: "no matching signer key in smart-account signature map" };
    } catch {
      return { signable: false, reason: "unsupported smart-account signature map shape" };
    }
  }

  return { signable: false, reason: "unsupported address type" };
}

export function canSignInput(parsed: ParsedInput, context: SignContext): Record<string, unknown> {
  if (parsed.kind === "tx") {
    const tx = TransactionBuilder.fromXDR(
      parsed.envelope.toXDR("base64"),
      context.network.network_passphrase,
    );
    const signingAddresses = collectSigningAddresses(tx);
    const matched = context.runtimeSigners.allKeypairs
      .map((kp) => kp.publicKey())
      .filter((pk) => signingAddresses.has(pk));

    const operations = getEnvelopeOperations(parsed.envelope);
    let signableAuth = 0;
    for (const op of operations) {
      if (op.body().switch().name !== "invokeHostFunction") continue;
      for (const auth of op.body().invokeHostFunctionOp().auth()) {
        if (canSignAuthEntry(auth, context).signable) signableAuth += 1;
      }
    }

    return {
      kind: "tx",
      signableEnvelopeSigners: matched,
      signableAuthEntries: signableAuth,
    };
  }

  const details = parsed.auth.map((entry, index) => {
    const result = canSignAuthEntry(entry, context);
    return {
      index,
      signable: result.signable,
      reason: result.reason,
    };
  });

  return {
    kind: parsed.kind,
    signableAuthEntries: details.filter((row) => row.signable).length,
    auth: details,
  };
}

export async function computeExpirationLedger(
  network: NetworkConfig,
  ttlSeconds: number,
  ledgerSeconds: number,
  latestLedgerOverride?: number,
): Promise<number> {
  const latestLedger =
    latestLedgerOverride ?? (await new rpc.Server(network.rpc_url).getLatestLedger()).sequence;
  return latestLedger + Math.ceil(ttlSeconds / ledgerSeconds);
}

export function signInput(
  parsed: ParsedInput,
  context: SignContext,
): {
  output: string;
  report: SignReport;
} {
  if (parsed.kind === "tx") {
    const { out, report } = signTransactionInput(parsed, context);
    return { output: out, report };
  }

  if (parsed.kind === "auth") {
    const { out, report } = signAuthInput(parsed, context);
    return { output: out, report };
  }

  const { out, report } = signBundleInput(parsed, context);
  return { output: out, report };
}

export function writeOutput(path: string, content: string): void {
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export function resolveAccountForCommand(
  config: WalletermConfig,
  networkName: string,
  explicitAccountAlias: string | undefined,
  parsed: ParsedInput,
): { alias: string; account: SmartAccountConfig } | null {
  const explicit = resolveAccount(config, networkName, explicitAccountAlias);
  if (explicit) return explicit;

  if (parsed.kind !== "tx") {
    for (const auth of parsed.auth) {
      if (auth.credentials().switch().name !== "sorobanCredentialsAddress") continue;
      const address = Address.fromScAddress(auth.credentials().address().address()).toString();
      if (!address.startsWith("C")) continue;
      const found = findAccountByContractId(config, networkName, address);
      if (found) return found;
    }
  }

  return resolveAccount(config, networkName, undefined);
}
