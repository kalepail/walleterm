import { afterEach, describe, expect, it, vi } from "vitest";
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
import { canSignInput, inspectInput } from "../../src/core.js";
import { KeypairSigner } from "../../src/signer.js";
import {
  CONTRACT,
  type MockedTxLike,
  makeAddressEntry,
  makeConfig,
  makeContext,
  makeInvokeContractOperation,
  makeRuntimeSigners,
  makeSourceAccountCredEntry,
  makeTxEnvelope,
  signerKeyDelegated,
  signerKeyExternal,
} from "../helpers/core-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core inspect", () => {
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

  it("inspectInput and canSignInput handle tx envelopes with no Soroban operations", () => {
    const source = Keypair.random();
    const txEnvelope = makeTxEnvelope([Operation.bumpSequence({ bumpTo: "2" })], source);
    const runtime = makeRuntimeSigners({
      delegated: [
        {
          kind: "delegated",
          name: "src",
          address: source.publicKey(),
          signer: new KeypairSigner(source),
        },
      ],
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
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(makeInvokeContractOperation(StrKey.encodeContract(Buffer.alloc(32, 16)), "f"))
      .build();
    inner.sign(innerSource);

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      "200",
      inner,
      Networks.TESTNET,
    );
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
        {
          kind: "delegated",
          name: "src",
          address: source.publicKey(),
          signer: new KeypairSigner(source),
        },
        {
          kind: "delegated",
          name: "inner",
          address: inner.publicKey(),
          signer: new KeypairSigner(inner),
        },
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
});
