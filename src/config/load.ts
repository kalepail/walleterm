import { readFileSync } from "node:fs";
import { parse } from "@iarna/toml";
import type {
  DelegatedSignerConfig,
  ExternalSignerConfig,
  MppIntent,
  PaymentProtocol,
  PaymentsConfig,
  SignerMode,
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

function readNonEmptyString(value: unknown, context: string): string {
  if (value === undefined) {
    throw new Error(`${context} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${context} is required`);
  }
  return value;
}

function readOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean`);
  }
  return value;
}

function readOptionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${context} must be a number`);
  }
  return value;
}

function normalizeExternalSigners(input: unknown, context: string): ExternalSignerConfig[] {
  const rows = asArray<Record<string, unknown>>(input, []);
  return rows.map((row, index) => {
    const itemContext = `${context}[${index}]`;
    const obj = assertObject(row, itemContext);
    return {
      name: readNonEmptyString(obj.name, `${itemContext}.name`),
      verifier_contract_id: readNonEmptyString(
        obj.verifier_contract_id,
        `${itemContext}.verifier_contract_id`,
      ),
      public_key_hex: readNonEmptyString(
        obj.public_key_hex,
        `${itemContext}.public_key_hex`,
      ).toLowerCase(),
      secret_ref: readNonEmptyString(obj.secret_ref, `${itemContext}.secret_ref`),
      enabled: readOptionalBoolean(obj.enabled, `${itemContext}.enabled`) ?? true,
    };
  });
}

function normalizeDelegatedSigners(input: unknown, context: string): DelegatedSignerConfig[] {
  const rows = asArray<Record<string, unknown>>(input, []);
  return rows.map((row, index) => {
    const itemContext = `${context}[${index}]`;
    const obj = assertObject(row, itemContext);
    return {
      name: readNonEmptyString(obj.name, `${itemContext}.name`),
      address: readNonEmptyString(obj.address, `${itemContext}.address`),
      secret_ref: readNonEmptyString(obj.secret_ref, `${itemContext}.secret_ref`),
      enabled: readOptionalBoolean(obj.enabled, `${itemContext}.enabled`) ?? true,
    };
  });
}

function normalizeX402Channel(input: unknown, context: string): X402ChannelConfig | undefined {
  if (!input) return undefined;
  const obj = assertObject(input, context);
  return {
    state_file: readOptionalString(obj.state_file, `${context}.state_file`),
    default_deposit: readOptionalString(obj.default_deposit, `${context}.default_deposit`),
    max_deposit_amount: readOptionalString(obj.max_deposit_amount, `${context}.max_deposit_amount`),
    commitment_secret_ref: readOptionalString(
      obj.commitment_secret_ref,
      `${context}.commitment_secret_ref`,
    ),
  };
}

function normalizeX402(input: unknown, context: string): X402Config | undefined {
  if (!input) return undefined;
  const obj = assertObject(input, context);
  return {
    default_payer_secret_ref: readOptionalString(
      obj.default_payer_secret_ref,
      `${context}.default_payer_secret_ref`,
    ),
    max_payment_amount: readOptionalString(obj.max_payment_amount, `${context}.max_payment_amount`),
    default_scheme: readOptionalString(obj.default_scheme, `${context}.default_scheme`) as
      | X402Config["default_scheme"]
      | undefined,
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
    default_protocol: readOptionalString(
      paymentsObj.default_protocol,
      "payments.default_protocol",
    ) as PaymentProtocol | undefined,
    mpp: mppObj
      ? {
          default_intent: readOptionalString(
            mppObj.default_intent,
            "payments.mpp.default_intent",
          ) as MppIntent | undefined,
          default_payer_secret_ref: readOptionalString(
            mppObj.default_payer_secret_ref,
            "payments.mpp.default_payer_secret_ref",
          ),
          max_payment_amount: readOptionalString(
            mppObj.max_payment_amount,
            "payments.mpp.max_payment_amount",
          ),
          channel: mppChannelObj
            ? {
                default_channel_contract_id: readOptionalString(
                  mppChannelObj.default_channel_contract_id,
                  "payments.mpp.channel.default_channel_contract_id",
                ),
                default_deposit: readOptionalString(
                  mppChannelObj.default_deposit,
                  "payments.mpp.channel.default_deposit",
                ),
                factory_contract_id: readOptionalString(
                  mppChannelObj.factory_contract_id,
                  "payments.mpp.channel.factory_contract_id",
                ),
                recipient: readOptionalString(
                  mppChannelObj.recipient,
                  "payments.mpp.channel.recipient",
                ),
                recipient_secret_ref: readOptionalString(
                  mppChannelObj.recipient_secret_ref,
                  "payments.mpp.channel.recipient_secret_ref",
                ),
                refund_waiting_period: readOptionalNumber(
                  mppChannelObj.refund_waiting_period,
                  "payments.mpp.channel.refund_waiting_period",
                ),
                source_account: readOptionalString(
                  mppChannelObj.source_account,
                  "payments.mpp.channel.source_account",
                ),
                state_file: readOptionalString(
                  mppChannelObj.state_file,
                  "payments.mpp.channel.state_file",
                ),
                token_contract_id: readOptionalString(
                  mppChannelObj.token_contract_id,
                  "payments.mpp.channel.token_contract_id",
                ),
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
    if (row.x402_facilitator_url !== undefined) {
      throw new Error(`networks.${name}.x402_facilitator_url is no longer supported`);
    }
    networks[name] = {
      rpc_url: readNonEmptyString(row.rpc_url, `networks.${name}.rpc_url`),
      network_passphrase: readNonEmptyString(
        row.network_passphrase,
        `networks.${name}.network_passphrase`,
      ),
      indexer_url: readOptionalString(row.indexer_url, `networks.${name}.indexer_url`),
      channels_base_url: readOptionalString(
        row.channels_base_url,
        `networks.${name}.channels_base_url`,
      ),
      channels_api_key_ref: readOptionalString(
        row.channels_api_key_ref,
        `networks.${name}.channels_api_key_ref`,
      ),
      deployer_secret_ref: readOptionalString(
        row.deployer_secret_ref,
        `networks.${name}.deployer_secret_ref`,
      ),
    };
  }

  const smart_accounts: Record<string, SmartAccountConfig> = {};
  for (const [alias, value] of Object.entries(smartAccountsObj)) {
    const row = assertObject(value, `smart_accounts.${alias}`);
    smart_accounts[alias] = {
      network: readNonEmptyString(row.network, `smart_accounts.${alias}.network`),
      contract_id: readNonEmptyString(row.contract_id, `smart_accounts.${alias}.contract_id`),
      expected_wasm_hash: readOptionalString(
        row.expected_wasm_hash,
        `smart_accounts.${alias}.expected_wasm_hash`,
      ),
      external_signers: normalizeExternalSigners(
        row.external_signers,
        `smart_accounts.${alias}.external_signers`,
      ),
      delegated_signers: normalizeDelegatedSigners(
        row.delegated_signers,
        `smart_accounts.${alias}.delegated_signers`,
      ),
    };
  }

  const config: WalletermConfig = {
    app: {
      default_network: readNonEmptyString(appObj.default_network, "app.default_network"),
      strict_onchain: readOptionalBoolean(appObj.strict_onchain, "app.strict_onchain") ?? true,
      onchain_signer_mode:
        (readOptionalString(appObj.onchain_signer_mode, "app.onchain_signer_mode") as
          | SignerMode
          | undefined) ?? "subset",
      default_ttl_seconds:
        readOptionalNumber(appObj.default_ttl_seconds, "app.default_ttl_seconds") ?? 30,
      assumed_ledger_time_seconds:
        readOptionalNumber(appObj.assumed_ledger_time_seconds, "app.assumed_ledger_time_seconds") ??
        6,
      default_submit_mode:
        readOptionalString(appObj.default_submit_mode, "app.default_submit_mode") ?? "sign-only",
    },
    networks,
    smart_accounts,
    payments: normalizePayments(parsed.payments),
  };

  validateConfig(config);
  return config;
}
