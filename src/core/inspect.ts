import { Address, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ParsedInput, SignContext } from "./types.js";
import { analyzeAuthEntry } from "./auth-entry.js";
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
        if (analyzeAuthEntry(auth, context).review.signable) signableAuth += 1;
      }
    }

    return {
      kind: "tx",
      signableEnvelopeSigners: matched,
      signableAuthEntries: signableAuth,
    };
  }

  const details = parsed.auth.map((entry, index) => {
    const result = analyzeAuthEntry(entry, context).review;
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
