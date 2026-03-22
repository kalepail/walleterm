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
