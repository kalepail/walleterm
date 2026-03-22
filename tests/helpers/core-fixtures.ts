import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { SmartAccountConfig, WalletermConfig } from "../../src/config.js";
import { KeypairSigner } from "../../src/signer.js";
import type { Signer } from "../../src/signer.js";
import type {
  RuntimeDelegatedSigner,
  RuntimeExternalSigner,
  RuntimeSigners,
  SignContext,
} from "../../src/core.js";
import type { SecretResolver } from "../../src/secrets.js";
import { makeTempDir } from "./temp-dir.js";

export type MockedTxLike = {
  source: string;
  operations: unknown;
  innerTransaction: {
    source: string;
    operations: unknown;
  };
};

export const PASS = Networks.TESTNET;
export const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

export function makeInvocation(
  contractId = CONTRACT,
  fnName = "execute",
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: fnName,
        args: [],
      }),
    ),
    subInvocations: [],
  });
}

export function makeAddressEntry(
  address: string,
  signature: xdr.ScVal = xdr.ScVal.scvVoid(),
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature,
      }),
    ),
    rootInvocation: makeInvocation(CONTRACT),
  });
}

export function makeSourceAccountCredEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: makeInvocation(CONTRACT),
  });
}

export function signerKeyExternal(verifierContractId: string, publicKeyHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierContractId).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
  ]);
}

export function signerKeyDelegated(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

export function makeRuntimeSigners(opts?: {
  external?: RuntimeExternalSigner[];
  delegated?: RuntimeDelegatedSigner[];
}): RuntimeSigners {
  const external = opts?.external ?? [];
  const delegated = opts?.delegated ?? [];

  const externalByComposite = new Map<string, RuntimeExternalSigner>();
  const delegatedByAddress = new Map<string, RuntimeDelegatedSigner>();
  const byAddress = new Map<string, Signer>();

  for (const row of external) {
    externalByComposite.set(`${row.verifierContractId}|${row.publicKeyHex.toLowerCase()}`, row);
    byAddress.set(row.signer.publicKey(), row.signer);
  }

  for (const row of delegated) {
    delegatedByAddress.set(row.address, row);
    byAddress.set(row.address, row.signer);
  }

  return {
    external,
    delegated,
    externalByComposite,
    delegatedByAddress,
    byAddress,
    allSigners: [...byAddress.values()],
  };
}

export function makeConfig(accounts?: Record<string, SmartAccountConfig>): WalletermConfig {
  return {
    app: {
      default_network: "testnet",
      strict_onchain: true,
      onchain_signer_mode: "subset",
      default_ttl_seconds: 30,
      assumed_ledger_time_seconds: 6,
      default_submit_mode: "sign-only",
    },
    networks: {
      testnet: {
        rpc_url: "https://rpc.invalid",
        network_passphrase: PASS,
      },
    },
    smart_accounts: accounts ?? {
      treasury: {
        network: "testnet",
        contract_id: CONTRACT,
        external_signers: [],
        delegated_signers: [],
      },
    },
  };
}

export function makeContext(opts?: {
  config?: WalletermConfig;
  accountRef?: { alias: string; account: SmartAccountConfig } | null;
  runtimeSigners?: RuntimeSigners;
  expirationLedger?: number;
}): SignContext {
  const config = opts?.config ?? makeConfig();
  return {
    config,
    networkName: "testnet",
    network: config.networks.testnet,
    accountRef:
      opts?.accountRef ??
      ({ alias: "treasury", account: config.smart_accounts.treasury! } as {
        alias: string;
        account: SmartAccountConfig;
      }),
    runtimeSigners: opts?.runtimeSigners ?? makeRuntimeSigners(),
    expirationLedger: opts?.expirationLedger ?? 123,
  };
}

export function tempFile(content: string): string {
  const dir = makeTempDir("walleterm-core-unit-");
  const path = join(dir, "input.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

export function makeResolver(map: Record<string, string>): SecretResolver {
  return {
    resolve: async (ref: string) => {
      if (!(ref in map)) throw new Error(`missing ${ref}`);
      return map[ref]!;
    },
  } as unknown as SecretResolver;
}

export function makeTxEnvelope(ops: xdr.Operation[], source?: Keypair): xdr.TransactionEnvelope {
  const kp = source ?? Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASS,
    timebounds: { minTime: 0, maxTime: 0 },
  });
  for (const op of ops) tx.addOperation(op);
  const built = tx.build();
  built.sign(kp);
  return xdr.TransactionEnvelope.fromXDR(built.toEnvelope().toXDR());
}

export function makeInvokeContractOperation(contractId = CONTRACT, fn = "transfer"): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: contractId,
    function: fn,
    args: [],
  });
}

export function makeDelegatedRuntimeSigner(name = "delegated") {
  const delegated = Keypair.random();
  return {
    keypair: delegated,
    runtime: {
      kind: "delegated" as const,
      name,
      address: delegated.publicKey(),
      signer: new KeypairSigner(delegated),
    },
  };
}
