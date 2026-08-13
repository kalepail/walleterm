import { Address, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "../signer.js";
import { selectAccountForAddress } from "./accounts.js";
import { compositeExternalKey } from "./runtime-signers.js";
import {
  appendMissingSmartAccountEntries,
  decodeSignerKey,
  ensureSignatureMap,
  UnsupportedSmartAccountSignatureShapeError,
  withExpiration,
} from "./smart-account.js";
import type {
  AccountRef,
  RuntimeDelegatedSigner,
  RuntimeExternalSigner,
  SignContext,
} from "./types.js";

export interface AuthEntryReview {
  signable: boolean;
  reason: string;
}

interface SkipAuthEntry {
  action: "skip";
  target: string;
  reason: string;
}

interface SignAccountAuthEntry {
  action: "sign";
  target: string;
  signer: Signer;
}

export type SmartAccountSignerAnalysis =
  | {
      kind: "unknown";
      mapEntry: xdr.ScMapEntry;
    }
  | {
      kind: "external";
      mapEntry: xdr.ScMapEntry;
      verifierContractId: string;
      publicKeyHex: string;
      signer: RuntimeExternalSigner | null;
    }
  | {
      kind: "delegated";
      mapEntry: xdr.ScMapEntry;
      address: string;
      signer: RuntimeDelegatedSigner | null;
    };

export type AuthEntryAnalysis =
  | {
      kind: "unsupportedCredentials";
      entry: xdr.SorobanAuthorizationEntry;
      review: AuthEntryReview;
      signing: SkipAuthEntry;
    }
  | {
      kind: "unsupportedAddress";
      entry: xdr.SorobanAuthorizationEntry;
      address: string;
      review: AuthEntryReview;
      signing: SkipAuthEntry;
    }
  | {
      kind: "accountAddress";
      entry: xdr.SorobanAuthorizationEntry;
      address: string;
      review: AuthEntryReview;
      signing: SkipAuthEntry | SignAccountAuthEntry;
    }
  | {
      kind: "missingSmartAccount";
      entry: xdr.SorobanAuthorizationEntry;
      address: string;
      review: AuthEntryReview;
      signing: SkipAuthEntry;
    }
  | {
      kind: "invalidSmartAccountSignature";
      entry: xdr.SorobanAuthorizationEntry;
      address: string;
      accountRef: AccountRef;
      review: AuthEntryReview;
      error: UnsupportedSmartAccountSignatureShapeError;
    }
  | {
      kind: "smartAccount";
      entry: xdr.SorobanAuthorizationEntry;
      address: string;
      accountRef: AccountRef;
      signatureMap: xdr.ScMapEntry[];
      signers: SmartAccountSignerAnalysis[];
      synthesized: boolean;
      review: AuthEntryReview;
    };

function analyzeSmartAccountSigner(
  mapEntry: xdr.ScMapEntry,
  context: SignContext,
): SmartAccountSignerAnalysis {
  const decoded = decodeSignerKey(mapEntry.key());
  if (!decoded) {
    return { kind: "unknown", mapEntry };
  }

  if (decoded.type === "external") {
    const composite = compositeExternalKey(decoded.verifierContractId, decoded.publicKeyHex);
    return {
      kind: "external",
      mapEntry,
      verifierContractId: decoded.verifierContractId,
      publicKeyHex: decoded.publicKeyHex,
      signer: context.runtimeSigners.externalByComposite.get(composite) ?? null,
    };
  }

  return {
    kind: "delegated",
    mapEntry,
    address: decoded.address,
    signer: context.runtimeSigners.delegatedByAddress.get(decoded.address) ?? null,
  };
}

function smartAccountReview(
  signers: SmartAccountSignerAnalysis[],
  synthesized: boolean,
): AuthEntryReview {
  if (synthesized) {
    return { signable: true, reason: "will synthesize signer map entries from config" };
  }

  if (signers.length === 0) {
    return { signable: false, reason: "no local signers" };
  }

  const matching = signers.find((row) => row.kind !== "unknown" && row.signer !== null);
  if (matching?.kind === "external") {
    return { signable: true, reason: "matching external signer key" };
  }
  if (matching?.kind === "delegated") {
    return { signable: true, reason: "matching delegated signer key" };
  }

  return { signable: false, reason: "no matching signer key in smart-account signature map" };
}

export function analyzeAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: SignContext,
): AuthEntryAnalysis {
  const preparedEntry = withExpiration(entry, context.expirationLedger);
  const credentials = preparedEntry.credentials();

  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    return {
      kind: "unsupportedCredentials",
      entry: preparedEntry,
      review: { signable: false, reason: "unsupported credential type" },
      signing: { action: "skip", target: "auth", reason: "unsupported credential type" },
    };
  }

  const address = Address.fromScAddress(credentials.address().address()).toString();

  if (address.startsWith("G")) {
    const signer = context.runtimeSigners.byAddress.get(address);
    return {
      kind: "accountAddress",
      entry: preparedEntry,
      address,
      review: {
        signable: Boolean(signer),
        reason: signer ? "matching local address signer" : "no local signer for address",
      },
      signing: signer
        ? { action: "sign", target: `auth:${address}`, signer }
        : { action: "skip", target: `auth:${address}`, reason: "no local key for address" },
    };
  }

  if (!address.startsWith("C")) {
    return {
      kind: "unsupportedAddress",
      entry: preparedEntry,
      address,
      review: { signable: false, reason: "unsupported address type" },
      signing: { action: "skip", target: `auth:${address}`, reason: "unsupported address format" },
    };
  }

  const accountRef = selectAccountForAddress(
    context.config,
    context.networkName,
    context.accountRef,
    address,
  );
  if (!accountRef) {
    return {
      kind: "missingSmartAccount",
      entry: preparedEntry,
      address,
      review: { signable: false, reason: "no smart-account config for contract" },
      signing: {
        action: "skip",
        target: `auth:${address}`,
        reason: "no matching smart account config for contract address",
      },
    };
  }

  let signatureMap: xdr.ScMapEntry[];
  try {
    signatureMap = ensureSignatureMap(credentials.address());
  } catch (error) {
    if (!(error instanceof UnsupportedSmartAccountSignatureShapeError)) {
      throw error;
    }
    return {
      kind: "invalidSmartAccountSignature",
      entry: preparedEntry,
      address,
      accountRef,
      review: { signable: false, reason: "unsupported smart-account signature map shape" },
      error,
    };
  }

  const synthesized =
    signatureMap.length === 0 &&
    (context.runtimeSigners.external.length > 0 || context.runtimeSigners.delegated.length > 0);
  if (signatureMap.length === 0) {
    appendMissingSmartAccountEntries(signatureMap, context.runtimeSigners);
  }

  const signers = signatureMap.map((mapEntry) => analyzeSmartAccountSigner(mapEntry, context));
  return {
    kind: "smartAccount",
    entry: preparedEntry,
    address,
    accountRef,
    signatureMap,
    signers,
    synthesized,
    review: smartAccountReview(signers, synthesized),
  };
}
