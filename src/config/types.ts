export type SignerMode = "subset" | "exact";
export type PaymentProtocol = "mpp" | "x402";
export type MppIntent = "charge" | "channel";
export type X402Scheme = "exact" | "channel" | "auto";

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

export interface X402ChannelConfig {
  state_file?: string;
  default_deposit?: string;
  max_deposit_amount?: string;
  commitment_secret_ref?: string;
}

export interface X402Config {
  default_payer_secret_ref?: string;
  max_payment_amount?: string;
  default_scheme?: X402Scheme;
  channel?: X402ChannelConfig;
}

export interface MppChannelConfig {
  default_channel_contract_id?: string;
  default_deposit?: string;
  factory_contract_id?: string;
  recipient?: string;
  recipient_secret_ref?: string;
  refund_waiting_period?: number;
  source_account?: string;
  state_file?: string;
  token_contract_id?: string;
}

export interface MppConfig {
  default_intent?: MppIntent;
  default_payer_secret_ref?: string;
  max_payment_amount?: string;
  channel?: MppChannelConfig;
}

export interface PaymentsConfig {
  default_protocol?: PaymentProtocol;
  mpp?: MppConfig;
  x402?: X402Config;
}

export interface WalletermConfig {
  app: AppSection;
  networks: Record<string, NetworkConfig>;
  smart_accounts: Record<string, SmartAccountConfig>;
  payments?: PaymentsConfig;
}
