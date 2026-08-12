import { resolveAccount, resolveNetwork, type WalletermConfig } from "../config.js";
import { SecretResolver } from "../secrets.js";
import { listContractSigners, reconcileContractSigners, resolveIndexerUrl } from "../wallet.js";
import { resolveAccountForCommand } from "./accounts.js";
import { canSignInput, inspectInput } from "./inspect.js";
import { loadRuntimeSigners } from "./runtime-signers.js";
import { computeExpirationLedger, signInput } from "./sign.js";
import type {
  AccountRef,
  ConfiguredReviewRequest,
  ConfiguredReviewResult,
  ConfiguredSignRequest,
  ConfiguredSignResult,
  NetworkConfig,
  SignContext,
  SmartAccountConfig,
} from "./types.js";

function formatSignerReconciliationIssue(
  kind: "missing" | "extra",
  reconciliation: {
    delegated: string[];
    external: Array<{ verifier_contract_id: string; public_key_hex: string }>;
  },
): string | null {
  const parts: string[] = [];
  if (reconciliation.delegated.length > 0) {
    parts.push(`delegated=[${reconciliation.delegated.join(", ")}]`);
  }
  if (reconciliation.external.length > 0) {
    parts.push(
      `external=[${reconciliation.external
        .map((row) => `${row.verifier_contract_id}:${row.public_key_hex}`)
        .join(", ")}]`,
    );
  }
  if (parts.length === 0) return null;
  return `${kind} ${parts.join(" ")}`;
}

async function getSignerReconciliation(
  config: WalletermConfig,
  network: NetworkConfig,
  account: SmartAccountConfig,
) {
  const indexerUrl = resolveIndexerUrl(network);
  const onchain = await listContractSigners(indexerUrl, account.contract_id);
  return reconcileContractSigners(
    account,
    onchain.signers,
    config.app.onchain_signer_mode ?? "subset",
  );
}

async function enforceStrictOnchainSigners(
  config: WalletermConfig,
  network: NetworkConfig,
  accountRef: AccountRef,
): Promise<void> {
  if (!config.app.strict_onchain) {
    return;
  }

  const reconciliation = await getSignerReconciliation(config, network, accountRef.account);
  if (reconciliation.ok) {
    return;
  }

  const parts = [
    formatSignerReconciliationIssue("missing", reconciliation.missing),
    reconciliation.mode === "exact"
      ? formatSignerReconciliationIssue("extra", reconciliation.extra)
      : null,
  ].filter(Boolean);

  throw new Error(
    `Strict on-chain signer reconciliation failed for account '${accountRef.alias}' (${reconciliation.mode}). ${parts.join("; ")}`,
  );
}

async function withRuntimeSigners<T>(
  accountRef: AccountRef,
  run: (runtimeSigners: SignContext["runtimeSigners"]) => Promise<T>,
): Promise<T> {
  const resolver = new SecretResolver();
  try {
    return await run(await loadRuntimeSigners(accountRef, resolver));
  } finally {
    resolver.clearCache();
  }
}

export async function reviewConfiguredInput(
  request: ConfiguredReviewRequest,
): Promise<ConfiguredReviewResult> {
  const inspection = inspectInput(request.input);
  const { name: networkName, config: network } = resolveNetwork(request.config, request.network);
  const accountRef = resolveAccountForCommand(
    request.config,
    networkName,
    request.account,
    request.input,
  );

  if (!accountRef) {
    return {
      inspection,
      signability: null,
      account: null,
      note: "No smart account selected. Pass --account <alias> or configure exactly one account on the selected network.",
    };
  }

  return withRuntimeSigners(accountRef, async (runtimeSigners) => {
    const signability = canSignInput(request.input, {
      config: request.config,
      networkName,
      network,
      accountRef,
      runtimeSigners,
      expirationLedger: 0,
    });

    let signerReconciliation: unknown = null;
    let signerReconciliationError: string | null = null;
    try {
      signerReconciliation = await getSignerReconciliation(
        request.config,
        network,
        accountRef.account,
      );
    } catch (error) {
      signerReconciliationError = error instanceof Error ? error.message : String(error);
    }

    return {
      inspection,
      signability,
      account: accountRef.alias,
      contract_id: accountRef.account.contract_id,
      signer_reconciliation: signerReconciliation,
      signer_reconciliation_error: signerReconciliationError,
    };
  });
}

export async function signConfiguredInput(
  request: ConfiguredSignRequest,
): Promise<ConfiguredSignResult> {
  const { name: networkName, config: network } = resolveNetwork(request.config, request.network);
  const accountRef =
    typeof request.input === "function"
      ? resolveAccount(request.config, networkName, request.account)
      : resolveAccountForCommand(request.config, networkName, request.account, request.input);

  if (!accountRef) {
    throw new Error(
      "No smart account selected. Pass --account <alias> or ensure there is exactly one account on the selected network.",
    );
  }

  await enforceStrictOnchainSigners(request.config, network, accountRef);

  return withRuntimeSigners(accountRef, async (runtimeSigners) => {
    const ttlSeconds = request.ttlSeconds ?? request.config.app.default_ttl_seconds ?? 30;
    const ledgerSeconds = request.config.app.assumed_ledger_time_seconds ?? 6;
    const expirationLedger = await computeExpirationLedger(
      network,
      ttlSeconds,
      ledgerSeconds,
      request.latestLedger,
    );
    const input =
      typeof request.input === "function"
        ? request.input({
            contractId: accountRef.account.contract_id,
            expirationLedger,
          })
        : request.input;
    const { output, report } = await signInput(input, {
      config: request.config,
      networkName,
      network,
      accountRef,
      runtimeSigners,
      expirationLedger,
    });

    return {
      output,
      report,
      account: accountRef.alias,
      contractId: accountRef.account.contract_id,
      expirationLedger,
    };
  });
}
