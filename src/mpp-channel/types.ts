import { Keypair } from "@stellar/stellar-sdk";

export interface StoredMppChannel {
  channel_id: string;
  network_name: string;
  network_passphrase: string;
  source_account: string;
  secret_ref?: string;
  deposit?: string;
  cumulative_amount?: string;
  last_voucher_amount?: string;
  last_voucher_signature?: string;
  refund_waiting_period?: number;
  factory_contract_id?: string;
  token_contract_id?: string;
  recipient?: string;
  lifecycle_state?: "open" | "closing" | "closed" | "refunded";
  opened_tx_hash?: string;
  last_topup_tx_hash?: string;
  last_settle_tx_hash?: string;
  close_start_tx_hash?: string;
  close_tx_hash?: string;
  refund_tx_hash?: string;
  updated_at: string;
}

export interface MppOpenChannelOptions {
  rpcUrl: string;
  networkName: string;
  networkPassphrase: string;
  keypair: Keypair;
  factoryContractId: string;
  tokenContractId: string;
  recipient: string;
  deposit: bigint;
  refundWaitingPeriod: number;
  statePath: string;
  secretRef?: string;
}

export interface MppTopUpChannelOptions {
  rpcUrl: string;
  networkName: string;
  networkPassphrase: string;
  keypair: Keypair;
  channelId: string;
  amount: bigint;
  statePath: string;
  secretRef?: string;
}

export interface MppCloseChannelOptions {
  rpcUrl: string;
  networkPassphrase: string;
  keypair: Keypair;
  channelId: string;
  amount: bigint;
  signatureHex: string;
  statePath: string;
}

export interface MppChannelStatusOptions {
  rpcUrl: string;
  networkPassphrase: string;
  channelId: string;
  sourceAccount: string;
}

export interface MppChannelStatus {
  channel_id: string;
  network: "public" | "testnet";
  token: string;
  from: string;
  to: string;
  deposited: string;
  withdrawn: string;
  balance: string;
  refund_waiting_period: number;
  close_effective_at_ledger: number | null;
  current_ledger: number;
}

export interface MppSettleChannelOptions {
  rpcUrl: string;
  networkName: string;
  networkPassphrase: string;
  keypair: Keypair;
  channelId: string;
  amount: bigint;
  signatureHex: string;
  statePath: string;
}

export interface MppStartCloseChannelOptions {
  rpcUrl: string;
  networkName: string;
  networkPassphrase: string;
  keypair: Keypair;
  channelId: string;
  statePath: string;
}

export interface MppRefundChannelOptions {
  rpcUrl: string;
  networkName: string;
  networkPassphrase: string;
  keypair: Keypair;
  channelId: string;
  statePath: string;
}
