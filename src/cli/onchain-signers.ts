import { listContractSigners, reconcileContractSigners, resolveIndexerUrl } from "../wallet.js";
import { resolveNetwork, type SmartAccountConfig, type WalletermConfig } from "../config.js";

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

export async function getSignerReconciliation(
  config: WalletermConfig,
  network: ReturnType<typeof resolveNetwork>["config"],
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

export async function enforceStrictOnchainSigners(
  config: WalletermConfig,
  network: ReturnType<typeof resolveNetwork>["config"],
  accountAlias: string,
  account: SmartAccountConfig,
): Promise<void> {
  if (!config.app.strict_onchain) {
    return;
  }

  const reconciliation = await getSignerReconciliation(config, network, account);
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
    `Strict on-chain signer reconciliation failed for account '${accountAlias}' (${reconciliation.mode}). ${parts.join("; ")}`,
  );
}
