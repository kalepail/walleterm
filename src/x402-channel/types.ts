import type { Keypair } from "@stellar/stellar-sdk";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import type { X402ChannelConfig, X402Scheme } from "../config.js";

export type X402ChannelMode = "state" | "demo";

export interface StoredX402Channel {
  channel_id: string;
  channel_context_key: string;
  network_name: string;
  network_passphrase: string;
  resource_origin: string;
  resource_pathname: string;
  asset: string;
  pay_to: string;
  payer_public_key: string;
  payer_secret_ref?: string;
  commitment_public_key: string;
  commitment_secret_ref?: string;
  channel_contract_id?: string;
  server_public_key?: string;
  price_per_request: string;
  deposit: string;
  current_cumulative: string;
  remaining_balance: string;
  current_iteration?: string;
  last_payment_signature?: string;
  last_server_signature?: string;
  mode: X402ChannelMode;
  lifecycle_state: "open" | "closing" | "closed" | "exhausted";
  opened_tx_hash?: string;
  closed_tx_hash?: string;
  updated_at: string;
}

export interface X402ChannelSummary {
  action: "open+pay" | "pay";
  mode: X402ChannelMode;
  channel_id: string;
  deposit: string;
  current_cumulative: string;
  remaining_balance: string;
  state_path: string;
  opened: boolean;
}

export interface X402ChannelResult {
  kind: "channel";
  scheme: "channel";
  paid: boolean;
  status: number;
  body: Uint8Array;
  responseHeaders: Record<string, string>;
  paymentRequired?: PaymentRequired;
  paymentPayload?: PaymentPayload;
  settlement?: SettleResponse | Record<string, unknown>;
  settlementError?: string;
  channel?: X402ChannelSummary;
}

export interface X402ChannelFallbackResult {
  kind: "fallback-exact";
}

export interface X402ChannelExecuteOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  x402Network: Network;
  networkName: string;
  networkPassphrase: string;
  rpcUrl: string;
  configPath: string;
  schemeSelection: X402Scheme;
  payerKeypair: Keypair;
  payerSecretRef?: string;
  commitmentKeypair: Keypair;
  commitmentSecretRef?: string;
  channelConfig?: X402ChannelConfig;
  depositOverride?: string;
  statePathOverride?: string;
  maxPaymentAmount?: string;
  dryRun?: boolean;
  yes?: boolean;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export type StateChannelOffer = {
  mode: "state";
  accepted: PaymentRequired["accepts"][number];
  price: string;
  asset: string;
  payTo: string;
  channelContract: string;
  serverPublicKey: string;
  suggestedDeposit?: string;
};

export type DemoChannelOffer = {
  mode: "demo";
  accepted: PaymentRequired["accepts"][number];
  price: string;
  asset: string;
  payTo: string;
  serverPublicKey?: string;
  suggestedDeposit?: string;
};

export type NormalizedChannelOffer = StateChannelOffer | DemoChannelOffer;

export interface DecodedHeader<T> {
  value?: T;
  error?: string;
}
