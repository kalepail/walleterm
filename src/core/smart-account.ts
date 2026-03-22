import { randomBytes } from "node:crypto";
import { Address, hash, xdr } from "@stellar/stellar-sdk";
import type { RuntimeDelegatedSigner, RuntimeSigners } from "./types.js";
import { compositeExternalKey } from "./runtime-signers.js";

export class UnsupportedSmartAccountSignatureShapeError extends Error {
  constructor() {
    super("Unsupported signature ScVal shape for smart-account entry");
    this.name = "UnsupportedSmartAccountSignatureShapeError";
  }
}

export function withExpiration(
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

export function authorizationPayload(
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

export function makeAddressSignatureScVal(publicKey: string, signature: Buffer): xdr.ScVal {
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

export function makeSignerKeyExternal(verifierContractId: string, publicKeyHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierContractId).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
  ]);
}

export function makeSignerKeyDelegated(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

export type DecodedSignerKey =
  | { type: "external"; verifierContractId: string; publicKeyHex: string }
  | { type: "delegated"; address: string }
  | null;

export function decodeSignerKey(key: xdr.ScVal): DecodedSignerKey {
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

export function ensureSignatureMap(credentials: xdr.SorobanAddressCredentials): xdr.ScMapEntry[] {
  const signature = credentials.signature();

  if (signature.switch().name === "scvVoid") {
    credentials.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]));
    return credentials.signature().vec()![0]!.map()!;
  }

  if (signature.switch().name !== "scvVec") {
    throw new UnsupportedSmartAccountSignatureShapeError();
  }

  const vec = signature.vec()!;
  if (vec.length === 0 || vec[0]!.switch().name !== "scvMap") {
    throw new UnsupportedSmartAccountSignatureShapeError();
  }

  return vec[0]!.map()!;
}

export function sortMapEntries(entries: xdr.ScMapEntry[]): void {
  entries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));
}

function randomNonceInt64(): xdr.Int64 {
  const raw = randomBytes(8);
  const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
  return xdr.Int64.fromString(value.toString());
}

export async function createDelegatedAuthEntry(
  contractId: string,
  delegated: RuntimeDelegatedSigner,
  signaturePayload: Buffer,
  expirationLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
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
  const signature = await delegated.signer.sign(delegatedPayload);

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

export function appendMissingSmartAccountEntries(
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

export function hasMatchingSignerInSignatureMap(
  sigMap: xdr.ScMapEntry[],
  runtimeSigners: RuntimeSigners,
): { signable: boolean; reason: string } {
  for (const item of sigMap) {
    const decoded = decodeSignerKey(item.key());
    if (!decoded) continue;
    if (decoded.type === "external") {
      const composite = compositeExternalKey(decoded.verifierContractId, decoded.publicKeyHex);
      if (runtimeSigners.externalByComposite.has(composite)) {
        return { signable: true, reason: "matching external signer key" };
      }
    } else if (runtimeSigners.delegatedByAddress.has(decoded.address)) {
      return { signable: true, reason: "matching delegated signer key" };
    }
  }

  return { signable: false, reason: "no matching signer key in smart-account signature map" };
}
