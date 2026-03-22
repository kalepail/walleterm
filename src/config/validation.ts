import type { WalletermConfig } from "./types.js";

const VALID_SIGNER_MODES = ["subset", "exact"];
const VALID_SUBMIT_MODES = ["sign-only", "channels"];
const VALID_PAYMENT_PROTOCOLS = ["mpp", "x402"];
const VALID_MPP_INTENTS = ["charge", "channel"];
const VALID_X402_SCHEMES = ["exact", "channel", "auto"];

function isInsecureUrl(url: string): boolean {
  if (!url.startsWith("http://")) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

function isHex32Byte(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(normalized);
}

function isNonNegativeIntegerString(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function warnInsecureUrl(field: string, url: string): void {
  if (isInsecureUrl(url)) {
    process.stderr.write(`Warning: ${field} uses non-HTTPS URL '${url}'\n`);
  }
}

export function validateConfig(config: WalletermConfig): void {
  if (!config.app.default_network) {
    throw new Error("app.default_network is required");
  }

  if (!config.networks[config.app.default_network]) {
    throw new Error(`default network '${config.app.default_network}' is not defined`);
  }

  if (
    config.app.onchain_signer_mode &&
    !VALID_SIGNER_MODES.includes(config.app.onchain_signer_mode)
  ) {
    throw new Error(`app.onchain_signer_mode must be one of: ${VALID_SIGNER_MODES.join(", ")}`);
  }

  if (
    config.app.default_submit_mode &&
    !VALID_SUBMIT_MODES.includes(config.app.default_submit_mode)
  ) {
    throw new Error(`app.default_submit_mode must be one of: ${VALID_SUBMIT_MODES.join(", ")}`);
  }

  if (config.app.default_ttl_seconds !== undefined && isNaN(config.app.default_ttl_seconds)) {
    throw new Error("app.default_ttl_seconds must be a valid number");
  }

  if (
    config.app.assumed_ledger_time_seconds !== undefined &&
    isNaN(config.app.assumed_ledger_time_seconds)
  ) {
    throw new Error("app.assumed_ledger_time_seconds must be a valid number");
  }

  if (
    config.payments?.default_protocol !== undefined &&
    !VALID_PAYMENT_PROTOCOLS.includes(config.payments.default_protocol)
  ) {
    throw new Error(
      `payments.default_protocol must be one of: ${VALID_PAYMENT_PROTOCOLS.join(", ")}`,
    );
  }

  if (
    config.payments?.mpp?.default_intent !== undefined &&
    !VALID_MPP_INTENTS.includes(config.payments.mpp.default_intent)
  ) {
    throw new Error(`payments.mpp.default_intent must be one of: ${VALID_MPP_INTENTS.join(", ")}`);
  }

  if (config.payments?.mpp?.max_payment_amount !== undefined) {
    const val = Number(config.payments.mpp.max_payment_amount);
    if (isNaN(val) || val < 0) {
      throw new Error(
        "payments.mpp.max_payment_amount must be a valid non-negative numeric string",
      );
    }
  }

  if (config.payments?.mpp?.channel?.default_deposit !== undefined) {
    const val = Number(config.payments.mpp.channel.default_deposit);
    if (isNaN(val) || val < 0) {
      throw new Error(
        "payments.mpp.channel.default_deposit must be a valid non-negative numeric string",
      );
    }
  }

  if (config.payments?.mpp?.channel?.refund_waiting_period !== undefined) {
    const val = config.payments.mpp.channel.refund_waiting_period;
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(
        "payments.mpp.channel.refund_waiting_period must be a valid non-negative number",
      );
    }
  }

  if (config.payments?.x402?.max_payment_amount !== undefined) {
    const val = Number(config.payments.x402.max_payment_amount);
    if (isNaN(val) || val < 0) {
      throw new Error(
        "payments.x402.max_payment_amount must be a valid non-negative numeric string",
      );
    }
  }

  if (
    config.payments?.x402?.default_scheme !== undefined &&
    !VALID_X402_SCHEMES.includes(config.payments.x402.default_scheme)
  ) {
    throw new Error(
      `payments.x402.default_scheme must be one of: ${VALID_X402_SCHEMES.join(", ")}`,
    );
  }

  if (config.payments?.x402?.channel?.default_deposit !== undefined) {
    if (!isNonNegativeIntegerString(config.payments.x402.channel.default_deposit)) {
      throw new Error(
        "payments.x402.channel.default_deposit must be a valid non-negative integer string",
      );
    }
  }

  if (config.payments?.x402?.channel?.max_deposit_amount !== undefined) {
    if (!isNonNegativeIntegerString(config.payments.x402.channel.max_deposit_amount)) {
      throw new Error(
        "payments.x402.channel.max_deposit_amount must be a valid non-negative integer string",
      );
    }
  }

  for (const [name, network] of Object.entries(config.networks)) {
    if (!network.rpc_url) throw new Error(`networks.${name}.rpc_url is required`);
    if (!network.network_passphrase) {
      throw new Error(`networks.${name}.network_passphrase is required`);
    }
    warnInsecureUrl(`networks.${name}.rpc_url`, network.rpc_url);
    if (network.indexer_url) warnInsecureUrl(`networks.${name}.indexer_url`, network.indexer_url);
    if (network.channels_base_url) {
      warnInsecureUrl(`networks.${name}.channels_base_url`, network.channels_base_url);
    }
    if (network.x402_facilitator_url) {
      warnInsecureUrl(`networks.${name}.x402_facilitator_url`, network.x402_facilitator_url);
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
    if (account.expected_wasm_hash && !isHex32Byte(account.expected_wasm_hash)) {
      throw new Error(`smart_accounts.${alias}.expected_wasm_hash must be a 32-byte hex string`);
    }
  }
}
