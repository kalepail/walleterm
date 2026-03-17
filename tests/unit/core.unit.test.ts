import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeFakeSshAgentFixture } from "../helpers/fake-ssh-agent.js";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  ExternalSignerConfig,
  SmartAccountConfig,
  WalletermConfig,
} from "../../src/config.js";
import { KeypairSigner } from "../../src/signer.js";
import type { Signer } from "../../src/signer.js";
import {
  canSignInput,
  computeExpirationLedger,
  inspectInput,
  listSignerConfig,
  loadRuntimeSigners,
  parseInputFile,
  resolveAccountForCommand,
  signInput,
  writeOutput,
  type ParsedInput,
  type RuntimeDelegatedSigner,
  type RuntimeExternalSigner,
  type RuntimeSigners,
  type SignContext,
} from "../../src/core.js";
import type { SecretResolver } from "../../src/secrets.js";

type MockedTxLike = {
  source: string;
  operations: unknown;
  innerTransaction: {
    source: string;
    operations: unknown;
  };
};

const PASS = Networks.TESTNET;
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

function makeInvocation(
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

function makeAddressEntry(
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

function makeSourceAccountCredEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: makeInvocation(CONTRACT),
  });
}

function signerKeyExternal(verifierContractId: string, publicKeyHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierContractId).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
  ]);
}

function signerKeyDelegated(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    xdr.ScVal.scvAddress(Address.fromString(address).toScAddress()),
  ]);
}

function makeRuntimeSigners(opts?: {
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

function makeConfig(accounts?: Record<string, SmartAccountConfig>): WalletermConfig {
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

function makeContext(opts?: {
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

function tempFile(content: string): string {
  const dir = makeTempDir("walleterm-core-unit-");
  const path = join(dir, "input.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

function makeResolver(map: Record<string, string>): SecretResolver {
  return {
    resolve: vi.fn(async (ref: string) => {
      if (!(ref in map)) throw new Error(`missing ${ref}`);
      return map[ref]!;
    }),
  } as unknown as SecretResolver;
}

function makeTxEnvelope(ops: xdr.Operation[], source?: Keypair): xdr.TransactionEnvelope {
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

function makeInvokeContractOperation(contractId = CONTRACT, fn = "transfer"): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: contractId,
    function: fn,
    args: [],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core unit", () => {
  it("parseInputFile validates bad and unsupported payloads", () => {
    expect(() => parseInputFile(tempFile("not xdr"))).toThrow(/neither base64 XDR nor JSON/i);
    expect(() => parseInputFile(tempFile("[]"))).toThrow(/must be an object/i);
    expect(() => parseInputFile(tempFile(JSON.stringify({ xdr: "abc" })))).toThrow(
      /not a recognized transaction\/auth XDR/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ auth: [1] })))).toThrow(
      /bundle\.auth\[0\] must be a base64 XDR string/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ auth: ["abc"] })))).toThrow(
      /bundle\.auth\[0\] is not a valid SorobanAuthorizationEntry XDR/i,
    );
    expect(() => parseInputFile(tempFile(JSON.stringify({ nope: true })))).toThrow(
      /Unsupported input JSON format/i,
    );
  });

  it("parseInputFile falls through to JSON parsing when valid base64 decodes to invalid XDR", () => {
    // Valid base64 that decodes to garbage bytes — not valid XDR for TransactionEnvelope
    // or SorobanAuthorizationEntry. The function should fail at JSON.parse and throw a
    // clear "neither base64 XDR nor JSON" error since it is not valid JSON either.
    const garbageBase64 = Buffer.from("this is not XDR at all!").toString("base64");
    expect(() => parseInputFile(tempFile(garbageBase64))).toThrow(/neither base64 XDR nor JSON/i);
  });

  it("parseInputFile accepts tx/auth xdr forms and bundle json", () => {
    const delegated = Keypair.random().publicKey();
    const authEntry = makeAddressEntry(delegated);
    const txEnvelope = makeTxEnvelope([makeInvokeContractOperation()]);

    const asTx = parseInputFile(tempFile(txEnvelope.toXDR("base64")));
    expect(asTx.kind).toBe("tx");

    const asAuth = parseInputFile(tempFile(authEntry.toXDR("base64")));
    expect(asAuth.kind).toBe("auth");

    const asJsonTx = parseInputFile(tempFile(JSON.stringify({ xdr: txEnvelope.toXDR("base64") })));
    expect(asJsonTx.kind).toBe("tx");

    const asJsonAuth = parseInputFile(tempFile(JSON.stringify({ xdr: authEntry.toXDR("base64") })));
    expect(asJsonAuth.kind).toBe("auth");

    const bundle = parseInputFile(
      tempFile(JSON.stringify({ func: "AAAA", auth: [authEntry.toXDR("base64")] })),
    );
    expect(bundle.kind).toBe("bundle");
    if (bundle.kind !== "bundle") {
      throw new Error("Expected bundle input");
    }
    expect(bundle.func).toBe("AAAA");
    expect(bundle.auth).toHaveLength(1);

    const bundleNoFunc = parseInputFile(
      tempFile(JSON.stringify({ auth: [authEntry.toXDR("base64")] })),
    );
    expect(bundleNoFunc.kind).toBe("bundle");
    if (bundleNoFunc.kind !== "bundle") {
      throw new Error("Expected bundle input");
    }
    expect(bundleNoFunc.func).toBeUndefined();
    expect(bundleNoFunc.auth).toHaveLength(1);
  });

  it("loadRuntimeSigners handles null account and disabled signers", async () => {
    const empty = await loadRuntimeSigners(null, makeResolver({}));
    expect(empty.allSigners).toHaveLength(0);

    const ext = Keypair.random();
    const del = Keypair.random();
    const account: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
      external_signers: [
        {
          name: "ext",
          verifier_contract_id: StrKey.encodeContract(Buffer.alloc(32, 2)),
          public_key_hex: Buffer.from(ext.rawPublicKey()).toString("hex"),
          secret_ref: "ext",
          enabled: false,
        },
      ],
      delegated_signers: [
        {
          name: "del",
          address: del.publicKey(),
          secret_ref: "del",
          enabled: false,
        },
      ],
    };

    const runtime = await loadRuntimeSigners(
      { alias: "treasury", account },
      makeResolver({ ext: ext.secret(), del: del.secret() }),
    );

    expect(runtime.external).toHaveLength(0);
    expect(runtime.delegated).toHaveLength(0);
  });

  it("handles accounts without signer arrays", async () => {
    const account: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
    };

    const runtime = await loadRuntimeSigners({ alias: "treasury", account }, makeResolver({}));
    expect(runtime.external).toHaveLength(0);
    expect(runtime.delegated).toHaveLength(0);

    const listed = listSignerConfig({ alias: "treasury", account });
    expect(listed.external).toHaveLength(0);
    expect(listed.delegated).toHaveLength(0);
  });

  it("loadRuntimeSigners validates seed and signer key matching", async () => {
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 10));
    const ext = Keypair.random();
    const other = Keypair.random();
    const del = Keypair.random();

    const badSeedAccount: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
      external_signers: [
        {
          name: "ext",
          verifier_contract_id: verifier,
          public_key_hex: Buffer.from(ext.rawPublicKey()).toString("hex"),
          secret_ref: "ext",
          enabled: true,
        },
      ],
      delegated_signers: [],
    };
    await expect(
      loadRuntimeSigners(
        { alias: "treasury", account: badSeedAccount },
        makeResolver({ ext: "not-a-seed" }),
      ),
    ).rejects.toThrow(/must resolve to a valid Stellar secret seed/i);

    const extMismatchAccount: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
      external_signers: [
        {
          name: "ext",
          verifier_contract_id: verifier,
          public_key_hex: Buffer.from(other.rawPublicKey()).toString("hex"),
          secret_ref: "ext",
          enabled: true,
        },
      ],
      delegated_signers: [],
    };
    await expect(
      loadRuntimeSigners(
        { alias: "treasury", account: extMismatchAccount },
        makeResolver({ ext: ext.secret() }),
      ),
    ).rejects.toThrow(/public key mismatch/i);

    const delMismatchAccount: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
      external_signers: [],
      delegated_signers: [
        {
          name: "del",
          address: other.publicKey(),
          secret_ref: "del",
          enabled: true,
        },
      ],
    };
    await expect(
      loadRuntimeSigners(
        { alias: "treasury", account: delMismatchAccount },
        makeResolver({ del: del.secret() }),
      ),
    ).rejects.toThrow(/address mismatch/i);
  });

  it("listSignerConfig normalizes rows and filters disabled", () => {
    const account: SmartAccountConfig = {
      network: "testnet",
      contract_id: CONTRACT,
      external_signers: [
        {
          name: "ext-enabled",
          verifier_contract_id: StrKey.encodeContract(Buffer.alloc(32, 1)),
          public_key_hex: "0xAA",
          secret_ref: "op://v/item/ext",
          enabled: true,
        },
        {
          name: "ext-disabled",
          verifier_contract_id: StrKey.encodeContract(Buffer.alloc(32, 2)),
          public_key_hex: "bb",
          secret_ref: "op://v/item/ext2",
          enabled: false,
        } as ExternalSignerConfig,
      ],
      delegated_signers: [
        {
          name: "del-enabled",
          address: Keypair.random().publicKey(),
          secret_ref: "op://v/item/del",
          enabled: true,
        },
        {
          name: "del-disabled",
          address: Keypair.random().publicKey(),
          secret_ref: "op://v/item/del2",
          enabled: false,
        },
      ],
    };

    const out = listSignerConfig({ alias: "treasury", account });
    expect(out.external).toHaveLength(1);
    expect(out.external[0]?.public_key_hex).toBe("aa");
    expect(out.delegated).toHaveLength(1);
  });

  it("inspectInput handles tx, auth credentials, and bundle hasFunc", () => {
    const tx = makeTxEnvelope([
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: "f",
        args: [],
        auth: [makeAddressEntry(Keypair.random().publicKey())],
      }),
      makeInvokeContractOperation(StrKey.encodeContract(Buffer.alloc(32, 8)), "g"),
    ]);

    const txInspect = inspectInput({ kind: "tx", envelope: tx });
    expect(txInspect.kind).toBe("tx");
    expect(txInspect.operations).toBe(2);
    expect(txInspect.authEntries).toBe(1);

    const authInspect = inspectInput({ kind: "auth", auth: [makeSourceAccountCredEntry()] });
    expect(authInspect.kind).toBe("auth");
    expect((authInspect.authEntries as Array<{ credentialType: string }>)[0]?.credentialType).toBe(
      "sorobanCredentialsSourceAccount",
    );

    const bundleInspect = inspectInput({
      kind: "bundle",
      func: "AAAA",
      auth: [makeAddressEntry(Keypair.random().publicKey())],
    });
    expect(bundleInspect.hasFunc).toBe(true);
  });

  it("inspectInput handles unknown envelope switch via fallback", () => {
    const fakeEnvelope = {
      switch: () => ({ name: "envelopeTypeTxV0" }),
    } as unknown as xdr.TransactionEnvelope;

    const out = inspectInput({ kind: "tx", envelope: fakeEnvelope });
    expect(out.operations).toBe(0);
    expect(out.authEntries).toBe(0);
  });

  it("signInput signs generic address entries and skips unsupported paths", async () => {
    const delegated = Keypair.random();
    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "d1",
          address: delegated.publicKey(),
          signer: new KeypairSigner(delegated),
        },
      ],
    });

    const ctx = makeContext({ runtimeSigners: runtime, accountRef: null });

    const signed = await signInput(
      { kind: "auth", auth: [makeAddressEntry(delegated.publicKey())] },
      ctx,
    );
    expect(signed.report.summary.signed).toBe(1);

    const skippedNoKey = await signInput(
      { kind: "auth", auth: [makeAddressEntry(Keypair.random().publicKey())] },
      makeContext({ runtimeSigners: makeRuntimeSigners(), accountRef: null }),
    );
    expect(skippedNoKey.report.summary.skipped).toBe(1);

    const skippedSourceCred = await signInput(
      { kind: "auth", auth: [makeSourceAccountCredEntry()] },
      makeContext({ runtimeSigners: makeRuntimeSigners(), accountRef: null }),
    );
    expect(skippedSourceCred.report.details[0]?.reason).toMatch(/unsupported credential type/i);

    const unknownContract = await signInput(
      {
        kind: "auth",
        auth: [makeAddressEntry(StrKey.encodeContract(Buffer.alloc(32, 77)))],
      },
      makeContext({ runtimeSigners: makeRuntimeSigners(), accountRef: null }),
    );
    expect(unknownContract.report.details[0]?.reason).toMatch(
      /no matching smart account config for contract address/i,
    );

    const spy = vi
      .spyOn(Address, "fromScAddress")
      .mockReturnValue({ toString: () => "X-NON-STELLAR" } as unknown as Address);
    const unsupported = await signInput(
      { kind: "auth", auth: [makeAddressEntry(delegated.publicKey())] },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    );
    expect(unsupported.report.details[0]?.reason).toMatch(/unsupported address format/i);
    spy.mockRestore();
  });

  it("signInput signs smart-account entries and expands delegated auth entries", async () => {
    const external = Keypair.random();
    const delegated = Keypair.random();
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 12));

    const runtime = makeRuntimeSigners({
      external: [
        {
          kind: "external",
          name: "ext",
          verifierContractId: verifier,
          publicKeyHex: Buffer.from(external.rawPublicKey()).toString("hex"),
          signer: new KeypairSigner(external),
        },
      ],
      delegated: [
        {
          kind: "delegated",
          name: "del",
          address: delegated.publicKey(),
          signer: new KeypairSigner(delegated),
        },
      ],
    });

    const entry = makeAddressEntry(CONTRACT, xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]));
    const result = await signInput(
      { kind: "auth", auth: [entry] },
      makeContext({ runtimeSigners: runtime }),
    );

    expect(result.report.summary.signed).toBeGreaterThanOrEqual(2);
    const out = JSON.parse(result.output) as { auth: string[] };
    expect(out.auth.length).toBe(2);
  });

  it("signInput skips unknown signer-map keys and missing local signer matches", async () => {
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 13));
    const unknownKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("UnknownType"),
      xdr.ScVal.scvAddress(
        Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 66))).toScAddress(),
      ),
    ]);
    const extKey = signerKeyExternal(verifier, Buffer.alloc(32, 9).toString("hex"));
    const delAddr = Keypair.random().publicKey();
    const delKey = signerKeyDelegated(delAddr);

    const entry = makeAddressEntry(
      CONTRACT,
      xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: unknownKey, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) }),
          new xdr.ScMapEntry({ key: extKey, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) }),
          new xdr.ScMapEntry({ key: delKey, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) }),
        ]),
      ]),
    );

    const out = await signInput(
      { kind: "auth", auth: [entry] },
      makeContext({ runtimeSigners: makeRuntimeSigners() }),
    );

    expect(out.report.summary.skipped).toBeGreaterThanOrEqual(3);
  });

  it("signInput throws on malformed smart-account signature map", async () => {
    const malformed = makeAddressEntry(CONTRACT, xdr.ScVal.scvMap([]));
    await expect(
      signInput(
        { kind: "auth", auth: [malformed] },
        makeContext({ runtimeSigners: makeRuntimeSigners() }),
      ),
    ).rejects.toThrow(/Unsupported signature ScVal shape/i);

    const malformedVec = makeAddressEntry(
      CONTRACT,
      xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(1))]),
    );
    await expect(
      signInput(
        { kind: "auth", auth: [malformedVec] },
        makeContext({ runtimeSigners: makeRuntimeSigners() }),
      ),
    ).rejects.toThrow(/Unsupported signature ScVal shape/i);
  });

  it("canSignInput covers G/C auth resolution, malformed map, and unsupported address type", () => {
    const delegated = Keypair.random();
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 14));
    const external = Keypair.random();

    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "del",
          address: delegated.publicKey(),
          signer: new KeypairSigner(delegated),
        },
      ],
      external: [
        {
          kind: "external",
          name: "ext",
          verifierContractId: verifier,
          publicKeyHex: Buffer.from(external.rawPublicKey()).toString("hex"),
          signer: new KeypairSigner(external),
        },
      ],
    });

    const cfg = makeConfig();
    const ctx = makeContext({ config: cfg, runtimeSigners: runtime });

    const gSignable = canSignInput(
      { kind: "auth", auth: [makeAddressEntry(delegated.publicKey())] },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(gSignable.auth[0]?.signable).toBe(true);

    const sourceCred = canSignInput(
      { kind: "auth", auth: [makeSourceAccountCredEntry()] },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(sourceCred.auth[0]?.reason).toMatch(/unsupported credential type/i);

    const gMissing = canSignInput(
      { kind: "auth", auth: [makeAddressEntry(Keypair.random().publicKey())] },
      makeContext({ config: cfg, runtimeSigners: makeRuntimeSigners() }),
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(gMissing.auth[0]?.reason).toMatch(/no local signer for address/i);

    const malformed = canSignInput(
      { kind: "auth", auth: [makeAddressEntry(CONTRACT, xdr.ScVal.scvMap([]))] },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(malformed.auth[0]?.reason).toMatch(/unsupported smart-account signature map shape/i);

    const noConfig = canSignInput(
      {
        kind: "auth",
        auth: [
          makeAddressEntry(
            StrKey.encodeContract(Buffer.alloc(32, 99)),
            xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]),
          ),
        ],
      },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(noConfig.auth[0]?.reason).toMatch(/no smart-account config for contract/i);

    const emptyNoSigners = canSignInput(
      {
        kind: "auth",
        auth: [makeAddressEntry(CONTRACT, xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]))],
      },
      makeContext({ config: cfg, runtimeSigners: makeRuntimeSigners() }),
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(emptyNoSigners.auth[0]?.reason).toMatch(/no local signers/i);

    const emptyWithLocal = canSignInput(
      {
        kind: "auth",
        auth: [makeAddressEntry(CONTRACT, xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]))],
      },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(emptyWithLocal.auth[0]?.reason).toMatch(
      /will synthesize signer map entries from config/i,
    );

    const extMap = xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKeyExternal(verifier, Buffer.from(external.rawPublicKey()).toString("hex")),
          val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
        }),
      ]),
    ]);
    const extSignable = canSignInput(
      { kind: "auth", auth: [makeAddressEntry(CONTRACT, extMap)] },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(extSignable.auth[0]?.reason).toMatch(/matching external signer key/i);

    const noMatch = canSignInput(
      {
        kind: "auth",
        auth: [
          makeAddressEntry(
            CONTRACT,
            xdr.ScVal.scvVec([
              xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: signerKeyDelegated(Keypair.random().publicKey()),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
              ]),
            ]),
          ),
        ],
      },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(noMatch.auth[0]?.reason).toMatch(/no matching signer key/i);

    const undecodable = canSignInput(
      {
        kind: "auth",
        auth: [
          makeAddressEntry(
            CONTRACT,
            xdr.ScVal.scvVec([
              xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvBool(true),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
              ]),
            ]),
          ),
        ],
      },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(undecodable.auth[0]?.reason).toMatch(/no matching signer key/i);

    const malformedKeys = canSignInput(
      {
        kind: "auth",
        auth: [
          makeAddressEntry(
            CONTRACT,
            xdr.ScVal.scvVec([
              xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated")]),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvVec([
                    xdr.ScVal.scvBool(true),
                    xdr.ScVal.scvAddress(
                      Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 67))).toScAddress(),
                    ),
                  ]),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvVec([
                    xdr.ScVal.scvSymbol("Delegated"),
                    xdr.ScVal.scvBool(true),
                  ]),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvVec([
                    xdr.ScVal.scvSymbol("External"),
                    xdr.ScVal.scvAddress(
                      Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 68))).toScAddress(),
                    ),
                  ]),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvVec([
                    xdr.ScVal.scvSymbol("External"),
                    xdr.ScVal.scvBool(true),
                    xdr.ScVal.scvBytes(Buffer.alloc(32)),
                  ]),
                  val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
                }),
              ]),
            ]),
          ),
        ],
      },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(malformedKeys.auth[0]?.reason).toMatch(/no matching signer key/i);

    const spy = vi
      .spyOn(Address, "fromScAddress")
      .mockReturnValue({ toString: () => "X-UNKNOWN" } as unknown as Address);
    const unsupported = canSignInput(
      { kind: "auth", auth: [makeAddressEntry(delegated.publicKey())] },
      ctx,
    ) as { auth: Array<{ signable: boolean; reason: string }> };
    expect(unsupported.auth[0]?.reason).toMatch(/unsupported address type/i);
    spy.mockRestore();
  });

  it("canSignInput and signInput on tx include envelope signer matching and auth signability", async () => {
    const source = Keypair.random();
    const delegated = Keypair.random();

    const authEntry = makeAddressEntry(delegated.publicKey());
    const txEnvelope = makeTxEnvelope(
      [
        makeInvokeContractOperation(StrKey.encodeContract(Buffer.alloc(32, 15)), "transfer"),
        Operation.invokeContractFunction({
          contract: CONTRACT,
          function: "f",
          args: [],
          auth: [authEntry],
        }),
        Operation.invokeContractFunction({
          contract: CONTRACT,
          function: "g",
          args: [],
        }),
      ],
      source,
    );

    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "del",
          address: delegated.publicKey(),
          signer: new KeypairSigner(delegated),
        },
        {
          kind: "delegated",
          name: "src",
          address: source.publicKey(),
          signer: new KeypairSigner(source),
        },
      ],
    });

    const ctx = makeContext({ runtimeSigners: runtime, accountRef: null });
    const can = canSignInput({ kind: "tx", envelope: txEnvelope }, ctx) as {
      signableEnvelopeSigners: string[];
      signableAuthEntries: number;
    };

    expect(can.signableEnvelopeSigners).toContain(source.publicKey());
    expect(can.signableAuthEntries).toBe(1);

    const signed = await signInput({ kind: "tx", envelope: txEnvelope }, ctx);
    expect(signed.report.summary.signed).toBeGreaterThanOrEqual(2);
  });

  it("signInput on tx skips non-Soroban operations and still signs envelope signatures", async () => {
    const source = Keypair.random();
    const txEnvelope = makeTxEnvelope([Operation.bumpSequence({ bumpTo: "2" })], source);

    const runtime = makeRuntimeSigners({
      delegated: [{ kind: "delegated", name: "src", address: source.publicKey(), signer: new KeypairSigner(source) }],
    });

    const signed = await signInput(
      { kind: "tx", envelope: txEnvelope },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    );

    expect(signed.report.summary.signed).toBe(1);
    expect(signed.report.details[0]?.target).toBe(`tx:${source.publicKey()}`);
  });

  it("inspectInput and canSignInput handle tx envelopes with no Soroban operations", () => {
    const source = Keypair.random();
    const txEnvelope = makeTxEnvelope([Operation.bumpSequence({ bumpTo: "2" })], source);
    const runtime = makeRuntimeSigners({
      delegated: [{ kind: "delegated", name: "src", address: source.publicKey(), signer: new KeypairSigner(source) }],
    });

    const inspected = inspectInput({ kind: "tx", envelope: txEnvelope });
    expect(inspected).toMatchObject({
      kind: "tx",
      operations: 1,
      authEntries: 0,
    });

    const can = canSignInput(
      { kind: "tx", envelope: txEnvelope },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    ) as { signableEnvelopeSigners: string[]; signableAuthEntries: number };
    expect(can.signableEnvelopeSigners).toContain(source.publicKey());
    expect(can.signableAuthEntries).toBe(0);
  });

  it("canSignInput handles fee-bump envelopes and inner transaction address collection", () => {
    const innerSource = Keypair.random();
    const feeSource = Keypair.random();

    const inner = new TransactionBuilder(new Account(innerSource.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(makeInvokeContractOperation(StrKey.encodeContract(Buffer.alloc(32, 16)), "f"))
      .build();
    inner.sign(innerSource);

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(feeSource, "200", inner, PASS);
    const envelope = xdr.TransactionEnvelope.fromXDR(feeBump.toEnvelope().toXDR());

    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "inner",
          address: innerSource.publicKey(),
          signer: new KeypairSigner(innerSource),
        },
        {
          kind: "delegated",
          name: "fee",
          address: feeSource.publicKey(),
          signer: new KeypairSigner(feeSource),
        },
      ],
    });

    const out = canSignInput(
      { kind: "tx", envelope },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    ) as { signableEnvelopeSigners: string[] };

    expect(out.signableEnvelopeSigners).toContain(innerSource.publicKey());
  });

  it("canSignInput tolerates non-array operation collections from parsed tx objects", () => {
    const source = Keypair.random();
    const inner = Keypair.random();
    const envelope = makeTxEnvelope(
      [makeInvokeContractOperation(StrKey.encodeContract(Buffer.alloc(32, 17)), "exec")],
      source,
    );

    const mockedTx: MockedTxLike = {
      source: source.publicKey(),
      operations: null,
      innerTransaction: { source: inner.publicKey(), operations: null },
    };

    const fromXdrSpy = vi
      .spyOn(TransactionBuilder, "fromXDR")
      .mockReturnValue(mockedTx as unknown as ReturnType<typeof TransactionBuilder.fromXDR>);

    const runtime = makeRuntimeSigners({
      delegated: [
        { kind: "delegated", name: "src", address: source.publicKey(), signer: new KeypairSigner(source) },
        { kind: "delegated", name: "inner", address: inner.publicKey(), signer: new KeypairSigner(inner) },
      ],
    });

    const out = canSignInput(
      { kind: "tx", envelope },
      makeContext({ runtimeSigners: runtime }),
    ) as { signableEnvelopeSigners: string[]; signableAuthEntries: number };

    expect(out.signableEnvelopeSigners).toEqual(
      expect.arrayContaining([source.publicKey(), inner.publicKey()]),
    );
    expect(out.signableAuthEntries).toBe(0);
    fromXdrSpy.mockRestore();
  });

  it("canSignInput on tx does not count unmatched external auth entries as signable", () => {
    const source = Keypair.random();
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 41));
    const localExternal = Keypair.random();
    const mismatchedKey = Buffer.alloc(32, 99).toString("hex");

    const authEntry = makeAddressEntry(
      CONTRACT,
      xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKeyExternal(verifier, mismatchedKey),
            val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
          }),
        ]),
      ]),
    );

    const envelope = makeTxEnvelope(
      [
        Operation.invokeContractFunction({
          contract: CONTRACT,
          function: "exec",
          args: [],
          auth: [authEntry],
        }),
      ],
      source,
    );

    const runtime = makeRuntimeSigners({
      external: [
        {
          kind: "external",
          name: "local",
          verifierContractId: verifier,
          publicKeyHex: Buffer.from(localExternal.rawPublicKey()).toString("hex"),
          signer: new KeypairSigner(localExternal),
        },
      ],
    });

    const out = canSignInput(
      { kind: "tx", envelope },
      makeContext({ runtimeSigners: runtime }),
    ) as { signableAuthEntries: number };

    expect(out.signableAuthEntries).toBe(0);
  });

  it("resolveAccountForCommand finds smart account from auth C-address and fallback behavior", () => {
    const contractA = StrKey.encodeContract(Buffer.alloc(32, 1));
    const contractB = StrKey.encodeContract(Buffer.alloc(32, 2));

    const cfg = makeConfig({
      a: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
      b: {
        network: "testnet",
        contract_id: contractB,
        external_signers: [],
        delegated_signers: [],
      },
    });

    const parsedAuth: ParsedInput = {
      kind: "auth",
      auth: [
        makeSourceAccountCredEntry(),
        makeAddressEntry(contractB, xdr.ScVal.scvVec([xdr.ScVal.scvMap([])])),
      ],
    };

    const found = resolveAccountForCommand(cfg, "testnet", undefined, parsedAuth);
    expect(found?.alias).toBe("b");

    const parsedNoMatch: ParsedInput = {
      kind: "auth",
      auth: [makeAddressEntry(StrKey.encodeContract(Buffer.alloc(32, 9)))],
    };
    expect(resolveAccountForCommand(cfg, "testnet", undefined, parsedNoMatch)).toBeNull();

    const parsedNonContract: ParsedInput = {
      kind: "auth",
      auth: [makeAddressEntry(Keypair.random().publicKey())],
    };
    expect(resolveAccountForCommand(cfg, "testnet", undefined, parsedNonContract)).toBeNull();

    const singleCfg = makeConfig({
      only: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
    });
    expect(
      resolveAccountForCommand(singleCfg, "testnet", undefined, {
        kind: "tx",
        envelope: makeTxEnvelope([makeInvokeContractOperation(contractA, "exec")]),
      }),
    )?.toMatchObject({ alias: "only" });
  });

  it("resolveAccountForCommand returns null for tx when alias is omitted and config is ambiguous", () => {
    const contractA = StrKey.encodeContract(Buffer.alloc(32, 3));
    const contractB = StrKey.encodeContract(Buffer.alloc(32, 4));
    const cfg = makeConfig({
      a: {
        network: "testnet",
        contract_id: contractA,
        external_signers: [],
        delegated_signers: [],
      },
      b: {
        network: "testnet",
        contract_id: contractB,
        external_signers: [],
        delegated_signers: [],
      },
    });

    const out = resolveAccountForCommand(cfg, "testnet", undefined, {
      kind: "tx",
      envelope: makeTxEnvelope([makeInvokeContractOperation(contractA, "exec")]),
    });
    expect(out).toBeNull();
  });

  it("signInput bundle omits func key when it is not provided", async () => {
    const delegated = Keypair.random();
    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "d1",
          address: delegated.publicKey(),
          signer: new KeypairSigner(delegated),
        },
      ],
    });

    const out = await signInput(
      { kind: "bundle", auth: [makeAddressEntry(delegated.publicKey())] },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    );
    const parsed = JSON.parse(out.output) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "func")).toBe(false);
  });

  it("computeExpirationLedger uses override and rpc fallback; writeOutput appends newline", async () => {
    expect(
      await computeExpirationLedger(
        { rpc_url: "https://rpc.invalid", network_passphrase: PASS },
        30,
        6,
        100,
      ),
    ).toBe(105);

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "mock-ledger-id",
      sequence: 200,
      protocolVersion: "22",
    });
    expect(
      await computeExpirationLedger(
        { rpc_url: "https://rpc.invalid", network_passphrase: PASS },
        60,
        6,
      ),
    ).toBe(210);

    const p1 = tempFile("");
    writeOutput(p1, "abc");
    expect(readFileSync(p1, "utf8")).toBe("abc\n");

    const p2 = tempFile("");
    writeOutput(p2, "abc\n");
    expect(readFileSync(p2, "utf8")).toBe("abc\n");
  });

  it("loadRuntimeSigners resolves ssh-agent:// refs via SSH agent protocol", async () => {
    const fx = await makeFakeSshAgentFixture();
    try {
      const ref = `ssh-agent://custom/${fx.stellarAddress}?socket=${encodeURIComponent(fx.socketPath)}`;
      const account: SmartAccountConfig = {
        network: "testnet",
        contract_id: CONTRACT,
        delegated_signers: [
          {
            name: "ssh-del",
            address: fx.stellarAddress,
            secret_ref: ref,
            enabled: true,
          },
        ],
      };

      const runtime = await loadRuntimeSigners(
        { alias: "treasury", account },
        makeResolver({}),
      );

      expect(runtime.delegated).toHaveLength(1);
      expect(runtime.delegated[0]!.address).toBe(fx.stellarAddress);
      expect(runtime.allSigners).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });
});
