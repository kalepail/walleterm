import type {
  DelegatedSignerConfig,
  ExternalSignerConfig,
  NetworkConfig,
  SmartAccountConfig,
  WalletermConfig,
} from "../config.js";
import type { Signer } from "../signer.js";
import type { xdr } from "@stellar/stellar-sdk";

export interface RuntimeExternalSigner {
  kind: "external";
  name: string;
  verifierContractId: string;
  publicKeyHex: string;
  signer: Signer;
}

export interface RuntimeDelegatedSigner {
  kind: "delegated";
  name: string;
  address: string;
  signer: Signer;
}

export interface RuntimeSigners {
  external: RuntimeExternalSigner[];
  delegated: RuntimeDelegatedSigner[];
  externalByComposite: Map<string, RuntimeExternalSigner>;
  delegatedByAddress: Map<string, RuntimeDelegatedSigner>;
  byAddress: Map<string, Signer>;
  allSigners: Signer[];
}

export interface SignDetail {
  target: string;
  action: "signed" | "skipped";
  reason: string;
}

export interface SignReport {
  kind: string;
  summary: {
    signed: number;
    skipped: number;
  };
  details: SignDetail[];
}

export interface SigningInputContext {
  contractId: string;
  expirationLedger: number;
}

export interface ConfiguredReviewRequest {
  config: WalletermConfig;
  input: ParsedInput;
  network?: string;
  account?: string;
}

export type ConfiguredReviewResult =
  | {
      inspection: Record<string, unknown>;
      signability: null;
      account: null;
      note: string;
    }
  | {
      inspection: Record<string, unknown>;
      signability: Record<string, unknown>;
      account: string;
      contract_id: string;
      signer_reconciliation: unknown;
      signer_reconciliation_error: string | null;
    };

export interface ConfiguredSignRequest {
  config: WalletermConfig;
  input: ParsedInput | ((context: SigningInputContext) => ParsedInput);
  network?: string;
  account?: string;
  ttlSeconds?: number;
  latestLedger?: number;
}

export interface ConfiguredSignResult {
  output: string;
  report: SignReport;
  account: string;
  contractId: string;
  expirationLedger: number;
}

export type ParsedInput =
  | {
      kind: "tx";
      envelope: xdr.TransactionEnvelope;
    }
  | {
      kind: "auth";
      auth: xdr.SorobanAuthorizationEntry[];
    }
  | {
      kind: "bundle";
      func?: string;
      auth: xdr.SorobanAuthorizationEntry[];
    };

export interface SignContext {
  config: WalletermConfig;
  networkName: string;
  network: NetworkConfig;
  accountRef: { alias: string; account: SmartAccountConfig } | null;
  runtimeSigners: RuntimeSigners;
  expirationLedger: number;
}

export type AccountRef = { alias: string; account: SmartAccountConfig };

export type SignerConfigSummary = {
  account: string;
  external: Array<{
    name: string;
    verifier_contract_id: string;
    public_key_hex: string;
    secret_ref: string;
  }>;
  delegated: Array<{ name: string; address: string; secret_ref: string }>;
};

export type { DelegatedSignerConfig, ExternalSignerConfig, NetworkConfig, SmartAccountConfig };
