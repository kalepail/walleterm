import { Address, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ParsedInput, SignContext } from "./types.js";
import { selectAccountForAddress } from "./accounts.js";
import {
  ensureSignatureMap,
  hasMatchingSignerInSignatureMap,
  withExpiration,
} from "./smart-account.js";
import { collectSigningAddresses, getEnvelopeOperations } from "./transactions.js";

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
  entry: Parameters<typeof withExpiration>[0],
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
    const accountRef = selectAccountForAddress(
      context.config,
      context.networkName,
      context.accountRef,
      address,
    );
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

      return hasMatchingSignerInSignatureMap(sigMap, context.runtimeSigners);
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
    const matched = context.runtimeSigners.allSigners
      .map((s) => s.publicKey())
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
