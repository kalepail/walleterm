import { TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { SignContext, SignReport } from "./types.js";

export function getEnvelopeOperations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
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

export function collectSigningAddresses(tx: unknown): Set<string> {
  const addresses = new Set<string>();
  const value = tx as Record<string, unknown>;

  const addMaybe = (addr: unknown): void => {
    if (typeof addr === "string" && addr) addresses.add(addr);
  };

  addMaybe(value.source);

  const ops = value.operations;
  if (Array.isArray(ops)) {
    for (const op of ops) {
      addMaybe((op as Record<string, unknown>).source);
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

export async function signEnvelopeSignatures(
  envelopeXdr: string,
  context: SignContext,
  reportSigned: (report: SignReport, target: string, reason: string) => void,
  report: SignReport,
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, context.network.network_passphrase);
  const signingAddresses = collectSigningAddresses(tx);

  for (const signer of context.runtimeSigners.allSigners) {
    if (!signingAddresses.has(signer.publicKey())) {
      continue;
    }

    await signer.signTransaction(tx);
    reportSigned(report, `tx:${signer.publicKey()}`, "added envelope signature");
  }

  return tx.toXDR();
}
