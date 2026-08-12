import { rpc, xdr } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "../config.js";
import { analyzeAuthEntry, type AuthEntryAnalysis } from "./auth-entry.js";
import {
  authorizationPayload,
  createDelegatedAuthEntry,
  makeAddressSignatureScVal,
  sortMapEntries,
} from "./smart-account.js";
import { signEnvelopeSignatures, getEnvelopeOperations } from "./transactions.js";
import type { ParsedInput, SignContext, SignReport } from "./types.js";

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

async function signGenericAddressEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: SignContext["runtimeSigners"]["allSigners"][number],
  report: SignReport,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  const payload = authorizationPayload(entry, networkPassphrase);
  const signature = await signer.sign(payload);
  entry.credentials().address().signature(makeAddressSignatureScVal(signer.publicKey(), signature));
  reportSigned(report, `auth:${signer.publicKey()}`, "signed address auth entry");
  return entry;
}

async function signSmartAccountEntry(
  analysis: Extract<AuthEntryAnalysis, { kind: "smartAccount" }>,
  report: SignReport,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const payload = authorizationPayload(analysis.entry, networkPassphrase);
  const creds = analysis.entry.credentials().address();

  const delegatedToExpand = new Map<string, SignContext["runtimeSigners"]["delegated"][number]>();

  for (const signerAnalysis of analysis.signers) {
    if (signerAnalysis.kind === "unknown") {
      reportSkipped(
        report,
        `auth:${analysis.accountRef.alias}`,
        "unrecognized signer key in signature map",
      );
      continue;
    }

    if (signerAnalysis.kind === "external") {
      const signer = signerAnalysis.signer;
      if (!signer) {
        reportSkipped(
          report,
          `auth:${analysis.accountRef.alias}`,
          `no local key for external signer ${signerAnalysis.verifierContractId}:${signerAnalysis.publicKeyHex}`,
        );
        continue;
      }

      const signature = await signer.signer.sign(payload);
      signerAnalysis.mapEntry.val(xdr.ScVal.scvBytes(signature));
      reportSigned(
        report,
        `auth:${analysis.accountRef.alias}`,
        `signed external signer ${signer.name}`,
      );
      continue;
    }

    const delegated = signerAnalysis.signer;
    if (!delegated) {
      reportSkipped(
        report,
        `auth:${analysis.accountRef.alias}`,
        `no local key for delegated signer ${signerAnalysis.address}`,
      );
      continue;
    }

    signerAnalysis.mapEntry.val(xdr.ScVal.scvBytes(Buffer.alloc(0)));
    delegatedToExpand.set(delegated.address, delegated);
    reportSigned(
      report,
      `auth:${analysis.accountRef.alias}`,
      `added delegated marker for ${delegated.name}`,
    );
  }

  sortMapEntries(analysis.signatureMap);
  creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap(analysis.signatureMap)]));

  const extraEntries: xdr.SorobanAuthorizationEntry[] = [analysis.entry];

  for (const delegated of delegatedToExpand.values()) {
    extraEntries.push(
      await createDelegatedAuthEntry(
        analysis.accountRef.account.contract_id,
        delegated,
        payload,
        creds.signatureExpirationLedger(),
        networkPassphrase,
      ),
    );
    reportSigned(
      report,
      `auth:${analysis.accountRef.alias}`,
      `generated delegated auth entry for ${delegated.name}`,
    );
  }

  return extraEntries;
}

async function signOneAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: SignContext,
  report: SignReport,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const analysis = analyzeAuthEntry(entry, context);

  if (analysis.kind === "invalidSmartAccountSignature") {
    throw analysis.error;
  }

  if (analysis.kind === "smartAccount") {
    return signSmartAccountEntry(analysis, report, context.network.network_passphrase);
  }

  if (analysis.signing.action === "skip") {
    reportSkipped(report, analysis.signing.target, analysis.signing.reason);
    return [analysis.entry];
  }

  return [
    await signGenericAddressEntry(
      analysis.entry,
      analysis.signing.signer,
      report,
      context.network.network_passphrase,
    ),
  ];
}

async function signAuthList(
  entries: xdr.SorobanAuthorizationEntry[],
  context: SignContext,
  report: SignReport,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const signed: xdr.SorobanAuthorizationEntry[] = [];

  for (const entry of entries) {
    const out = await signOneAuthEntry(entry, context, report);
    signed.push(...out);
  }

  return signed;
}

async function signTransactionInput(
  parsed: ParsedInput & { kind: "tx" },
  context: SignContext,
): Promise<{
  out: string;
  report: SignReport;
}> {
  const report = createReport("tx");
  const envelope = xdr.TransactionEnvelope.fromXDR(parsed.envelope.toXDR());

  const operations = getEnvelopeOperations(envelope);
  for (const op of operations) {
    if (op.body().switch().name !== "invokeHostFunction") {
      continue;
    }

    const invoke = op.body().invokeHostFunctionOp();
    const authEntries = invoke.auth();
    const signedAuth = await signAuthList(authEntries, context, report);
    invoke.auth(signedAuth);
  }

  const signedEnvelopeXdr = await signEnvelopeSignatures(
    envelope.toXDR("base64"),
    context,
    reportSigned,
    report,
  );
  return { out: signedEnvelopeXdr, report };
}

async function signAuthInput(
  parsed: ParsedInput & { kind: "auth" },
  context: SignContext,
): Promise<{
  out: string;
  report: SignReport;
}> {
  const report = createReport("auth");
  const signed = await signAuthList(parsed.auth, context, report);

  if (signed.length === 1) {
    return { out: signed[0]!.toXDR("base64"), report };
  }

  return {
    out: JSON.stringify({ auth: signed.map((entry) => entry.toXDR("base64")) }, null, 2),
    report,
  };
}

async function signBundleInput(
  parsed: ParsedInput & { kind: "bundle" },
  context: SignContext,
): Promise<{
  out: string;
  report: SignReport;
}> {
  const report = createReport("bundle");
  const signed = await signAuthList(parsed.auth, context, report);

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

export async function signInput(
  parsed: ParsedInput,
  context: SignContext,
): Promise<{
  output: string;
  report: SignReport;
}> {
  if (parsed.kind === "tx") {
    const { out, report } = await signTransactionInput(parsed, context);
    return { output: out, report };
  }

  if (parsed.kind === "auth") {
    const { out, report } = await signAuthInput(parsed, context);
    return { output: out, report };
  }

  const { out, report } = await signBundleInput(parsed, context);
  return { output: out, report };
}
