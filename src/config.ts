import { readFileSync } from "node:fs";
import { parse } from "@iarna/toml";

export type SignerMode = "subset" | "exact";

export interface AppSection {
  default_network: string;
  strict_onchain?: boolean;
  onchain_signer_mode?: SignerMode;
  default_ttl_seconds?: number;
  assumed_ledger_time_seconds?: number;
  default_submit_mode?: string;
}

export interface NetworkConfig {
  rpc_url: string;
  network_passphrase: string;
  indexer_url?: string;
  channels_base_url?: string;
  channels_api_key_ref?: string;
  deployer_secret_ref?: string;
  x402_facilitator_url?: string;
}

export interface ExternalSignerConfig {
  name: string;
  verifier_contract_id: string;
  public_key_hex: string;
  secret_ref: string;
  enabled?: boolean;
}

export interface DelegatedSignerConfig {
  name: string;
  address: string;
  secret_ref: string;
  enabled?: boolean;
}

export interface SmartAccountConfig {
  network: string;
  contract_id: string;
  expected_wasm_hash?: string;
  external_signers?: ExternalSignerConfig[];
  delegated_signers?: DelegatedSignerConfig[];
}

export interface X402Config {
  default_payer_secret_ref?: string;
}

export interface WalletermConfig {
  app: AppSection;
  networks: Record<string, NetworkConfig>;
  smart_accounts: Record<string, SmartAccountConfig>;
  x402?: X402Config;
}

function assertObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a table/object`);
  }
  return value as Record<string, unknown>;
}

function asArray<T>(value: unknown, fallback: T[]): T[] {
  if (!value) return fallback;
  if (!Array.isArray(value)) throw new Error("Expected array value in config");
  return value as T[];
}

function normalizeExternalSigners(input: unknown): ExternalSignerConfig[] {
  const rows = asArray<Record<string, unknown>>(input, []);
  return rows.map((row, index) => {
    const obj = assertObject(row, `external_signers[${index}]`);
    return {
      name: String(obj.name ?? ""),
      verifier_contract_id: String(obj.verifier_contract_id ?? ""),
      public_key_hex: String(obj.public_key_hex ?? "").toLowerCase(),
      secret_ref: String(obj.secret_ref ?? ""),
      enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
    };
  });
}

function normalizeDelegatedSigners(input: unknown): DelegatedSignerConfig[] {
  const rows = asArray<Record<string, unknown>>(input, []);
  return rows.map((row, index) => {
    const obj = assertObject(row, `delegated_signers[${index}]`);
    return {
      name: String(obj.name ?? ""),
      address: String(obj.address ?? ""),
      secret_ref: String(obj.secret_ref ?? ""),
      enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
    };
  });
}

export function loadConfig(path: string): WalletermConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) as Record<string, unknown>;

  const appObj = assertObject(parsed.app, "app");
  const networksObj = assertObject(parsed.networks, "networks");
  const smartAccountsObj = assertObject(parsed.smart_accounts, "smart_accounts");

  const networks: Record<string, NetworkConfig> = {};
  for (const [name, value] of Object.entries(networksObj)) {
    const row = assertObject(value, `networks.${name}`);
    networks[name] = {
      rpc_url: String(row.rpc_url ?? ""),
      network_passphrase: String(row.network_passphrase ?? ""),
      indexer_url: row.indexer_url ? String(row.indexer_url) : undefined,
      channels_base_url: row.channels_base_url ? String(row.channels_base_url) : undefined,
      channels_api_key_ref: row.channels_api_key_ref ? String(row.channels_api_key_ref) : undefined,
      deployer_secret_ref: row.deployer_secret_ref ? String(row.deployer_secret_ref) : undefined,
      x402_facilitator_url: row.x402_facilitator_url ? String(row.x402_facilitator_url) : undefined,
    };
  }

  const smartAccounts: Record<string, SmartAccountConfig> = {};
  for (const [alias, value] of Object.entries(smartAccountsObj)) {
    const row = assertObject(value, `smart_accounts.${alias}`);
    smartAccounts[alias] = {
      network: String(row.network ?? ""),
      contract_id: String(row.contract_id ?? ""),
      expected_wasm_hash: row.expected_wasm_hash ? String(row.expected_wasm_hash) : undefined,
      external_signers: normalizeExternalSigners(row.external_signers),
      delegated_signers: normalizeDelegatedSigners(row.delegated_signers),
    };
  }

  let x402: X402Config | undefined;
  if (parsed.x402) {
    const x402Obj = assertObject(parsed.x402, "x402");
    x402 = {
      default_payer_secret_ref: x402Obj.default_payer_secret_ref
        ? String(x402Obj.default_payer_secret_ref)
        : undefined,
    };
  }

  const config: WalletermConfig = {
    app: {
      default_network: String(appObj.default_network ?? ""),
      strict_onchain: appObj.strict_onchain === undefined ? true : Boolean(appObj.strict_onchain),
      onchain_signer_mode: (appObj.onchain_signer_mode as SignerMode | undefined) ?? "subset",
      default_ttl_seconds: Number(appObj.default_ttl_seconds ?? 30),
      assumed_ledger_time_seconds: Number(appObj.assumed_ledger_time_seconds ?? 6),
      default_submit_mode: appObj.default_submit_mode
        ? String(appObj.default_submit_mode)
        : "sign-only",
    },
    networks,
    smart_accounts: smartAccounts,
    x402,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: WalletermConfig): void {
  if (!config.app.default_network) {
    throw new Error("app.default_network is required");
  }

  if (!config.networks[config.app.default_network]) {
    throw new Error(`default network '${config.app.default_network}' is not defined`);
  }

  for (const [name, network] of Object.entries(config.networks)) {
    if (!network.rpc_url) throw new Error(`networks.${name}.rpc_url is required`);
    if (!network.network_passphrase) {
      throw new Error(`networks.${name}.network_passphrase is required`);
    }
  }

  for (const [alias, account] of Object.entries(config.smart_accounts)) {
    if (!account.network) throw new Error(`smart_accounts.${alias}.network is required`);
    if (!account.contract_id) {
      throw new Error(`smart_accounts.${alias}.contract_id is required`);
    }
    if (!config.networks[account.network]) {
      throw new Error(`smart_accounts.${alias}.network '${account.network}' is not configured`);
    }
  }
}

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
