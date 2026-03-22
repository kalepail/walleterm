import type { NetworkConfig, SmartAccountConfig, WalletermConfig } from "./types.js";

export function resolveNetwork(
  config: WalletermConfig,
  explicit?: string,
): {
  name: string;
  config: NetworkConfig;
} {
  const name = explicit ?? config.app.default_network;
  const network = config.networks[name];
  if (!network) {
    throw new Error(`Network '${name}' not found in config`);
  }
  return { name, config: network };
}

export function resolveAccount(
  config: WalletermConfig,
  network: string,
  explicitAlias?: string,
): { alias: string; account: SmartAccountConfig } | null {
  if (explicitAlias) {
    const found = config.smart_accounts[explicitAlias];
    if (!found) throw new Error(`Smart account '${explicitAlias}' not found`);
    if (found.network !== network) {
      throw new Error(
        `Smart account '${explicitAlias}' belongs to network '${found.network}', not '${network}'`,
      );
    }
    return { alias: explicitAlias, account: found };
  }

  const matches = Object.entries(config.smart_accounts).filter(
    ([, account]) => account.network === network,
  );
  if (matches.length === 1) {
    const [alias, account] = matches[0]!;
    return { alias, account };
  }

  return null;
}

export function findAccountByContractId(
  config: WalletermConfig,
  network: string,
  contractId: string,
): { alias: string; account: SmartAccountConfig } | null {
  const matches = Object.entries(config.smart_accounts).filter(
    ([, account]) => account.network === network && account.contract_id === contractId,
  );
  if (matches.length === 0) return null;
  const [alias, account] = matches[0]!;
  return { alias, account };
}
