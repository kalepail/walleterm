import { readFileSync } from "node:fs";
import { parse } from "@iarna/toml";
import type {
  MppIntent,
  PaymentProtocol,
  SignerMode,
  DelegatedSignerConfig,
  ExternalSignerConfig,
  PaymentsConfig,
  SmartAccountConfig,
  WalletermConfig,
  X402ChannelConfig,
  X402Config,
} from "./types.js";
import { validateConfig } from "./validation.js";

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

function normalizeX402Channel(input: unknown, context: string): X402ChannelConfig | undefined {
  if (!input) return undefined;
  const obj = assertObject(input, context);
  return {
    state_file: obj.state_file ? String(obj.state_file) : undefined,
    default_deposit: obj.default_deposit ? String(obj.default_deposit) : undefined,
    max_deposit_amount: obj.max_deposit_amount ? String(obj.max_deposit_amount) : undefined,
    commitment_secret_ref: obj.commitment_secret_ref
      ? String(obj.commitment_secret_ref)
      : undefined,
  };
}

function normalizeX402(input: unknown, context: string): X402Config | undefined {
  if (!input) return undefined;
  const obj = assertObject(input, context);
  return {
    default_payer_secret_ref: obj.default_payer_secret_ref
      ? String(obj.default_payer_secret_ref)
      : undefined,
    max_payment_amount: obj.max_payment_amount ? String(obj.max_payment_amount) : undefined,
    default_scheme: obj.default_scheme
      ? (String(obj.default_scheme) as X402Config["default_scheme"])
      : undefined,
    channel: normalizeX402Channel(obj.channel, `${context}.channel`),
  };
}

function normalizePayments(input: unknown): PaymentsConfig | undefined {
  if (!input) return undefined;
  const paymentsObj = assertObject(input, "payments");
  const mppObj = paymentsObj.mpp ? assertObject(paymentsObj.mpp, "payments.mpp") : undefined;
  const mppChannelObj = mppObj?.channel
    ? assertObject(mppObj.channel, "payments.mpp.channel")
    : undefined;

  return {
    default_protocol: paymentsObj.default_protocol
      ? (String(paymentsObj.default_protocol) as PaymentProtocol)
      : undefined,
    mpp: mppObj
      ? {
          default_intent: mppObj.default_intent
            ? (String(mppObj.default_intent) as MppIntent)
            : undefined,
          default_payer_secret_ref: mppObj.default_payer_secret_ref
            ? String(mppObj.default_payer_secret_ref)
            : undefined,
          max_payment_amount: mppObj.max_payment_amount
            ? String(mppObj.max_payment_amount)
            : undefined,
          channel: mppChannelObj
            ? {
                default_channel_contract_id: mppChannelObj.default_channel_contract_id
                  ? String(mppChannelObj.default_channel_contract_id)
                  : undefined,
                default_deposit: mppChannelObj.default_deposit
                  ? String(mppChannelObj.default_deposit)
                  : undefined,
                factory_contract_id: mppChannelObj.factory_contract_id
                  ? String(mppChannelObj.factory_contract_id)
                  : undefined,
                recipient: mppChannelObj.recipient ? String(mppChannelObj.recipient) : undefined,
                recipient_secret_ref: mppChannelObj.recipient_secret_ref
                  ? String(mppChannelObj.recipient_secret_ref)
                  : undefined,
                refund_waiting_period:
                  mppChannelObj.refund_waiting_period === undefined
                    ? undefined
                    : Number(mppChannelObj.refund_waiting_period),
                source_account: mppChannelObj.source_account
                  ? String(mppChannelObj.source_account)
                  : undefined,
                state_file: mppChannelObj.state_file ? String(mppChannelObj.state_file) : undefined,
                token_contract_id: mppChannelObj.token_contract_id
                  ? String(mppChannelObj.token_contract_id)
                  : undefined,
              }
            : undefined,
        }
      : undefined,
    x402: normalizeX402(paymentsObj.x402, "payments.x402"),
  };
}

export function loadConfig(path: string): WalletermConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) as Record<string, unknown>;

  if (parsed.x402 !== undefined) {
    throw new Error("Top-level [x402] is no longer supported. Use [payments.x402] instead.");
  }

  const appObj = assertObject(parsed.app, "app");
  const networksObj = assertObject(parsed.networks, "networks");
  const smartAccountsObj = assertObject(parsed.smart_accounts, "smart_accounts");

  const networks: WalletermConfig["networks"] = {};
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

  const smart_accounts: Record<string, SmartAccountConfig> = {};
  for (const [alias, value] of Object.entries(smartAccountsObj)) {
    const row = assertObject(value, `smart_accounts.${alias}`);
    smart_accounts[alias] = {
      network: String(row.network ?? ""),
      contract_id: String(row.contract_id ?? ""),
      expected_wasm_hash: row.expected_wasm_hash ? String(row.expected_wasm_hash) : undefined,
      external_signers: normalizeExternalSigners(row.external_signers),
      delegated_signers: normalizeDelegatedSigners(row.delegated_signers),
    };
  }

  const config: WalletermConfig = {
    app: {
      default_network: String(appObj.default_network ?? ""),
      strict_onchain: appObj.strict_onchain === undefined ? true : Boolean(appObj.strict_onchain),
      onchain_signer_mode: appObj.onchain_signer_mode
        ? (String(appObj.onchain_signer_mode) as SignerMode)
        : "subset",
      default_ttl_seconds: Number(appObj.default_ttl_seconds ?? 30),
      assumed_ledger_time_seconds: Number(appObj.assumed_ledger_time_seconds ?? 6),
      default_submit_mode: appObj.default_submit_mode
        ? String(appObj.default_submit_mode)
        : "sign-only",
    },
    networks,
    smart_accounts,
    payments: normalizePayments(parsed.payments),
  };

  validateConfig(config);
  return config;
}
