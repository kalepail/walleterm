import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "../config.js";
import { selectAccountForAddress } from "./accounts.js";
import {
  appendMissingSmartAccountEntries,
  authorizationPayload,
  createDelegatedAuthEntry,
  decodeSignerKey,
  ensureSignatureMap,
  makeAddressSignatureScVal,
  sortMapEntries,
  withExpiration,
} from "./smart-account.js";
import { signEnvelopeSignatures, getEnvelopeOperations } from "./transactions.js";
import { compositeExternalKey } from "./runtime-signers.js";
import type { AccountRef, ParsedInput, SignContext, SignReport } from "./types.js";

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
  entry: xdr.SorobanAuthorizationEntry,
  accountRef: AccountRef,
  runtimeSigners: SignContext["runtimeSigners"],
  report: SignReport,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const payload = authorizationPayload(entry, networkPassphrase);
  const creds = entry.credentials().address();
  const sigMap = ensureSignatureMap(creds);

  if (sigMap.length === 0) {
    appendMissingSmartAccountEntries(sigMap, runtimeSigners);
  }

  const delegatedToExpand = new Map<string, SignContext["runtimeSigners"]["delegated"][number]>();

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

      const signature = await signer.signer.sign(payload);
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
      await createDelegatedAuthEntry(
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

async function signOneAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  context: SignContext,
  report: SignReport,
): Promise<xdr.SorobanAuthorizationEntry[]> {
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

    return [
      await signGenericAddressEntry(entry, signer, report, context.network.network_passphrase),
    ];
  }

  if (authAddress.startsWith("C")) {
    const accountRef = selectAccountForAddress(
      context.config,
      context.networkName,
      context.accountRef,
      authAddress,
    );
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

async function signAuthList(
  entries: xdr.SorobanAuthorizationEntry[],
  context: SignContext,
  report: SignReport,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const signed: xdr.SorobanAuthorizationEntry[] = [];

  for (const entry of entries) {
    const withTtl = withExpiration(entry, context.expirationLedger);
    const out = await signOneAuthEntry(withTtl, context, report);
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
