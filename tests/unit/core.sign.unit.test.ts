import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, Operation, StrKey, xdr } from "@stellar/stellar-sdk";
import { canSignInput, signInput } from "../../src/core.js";
import { KeypairSigner } from "../../src/signer.js";
import {
  CONTRACT,
  makeAddressEntry,
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

describe("core sign", () => {
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
      delegated: [
        {
          kind: "delegated",
          name: "src",
          address: source.publicKey(),
          signer: new KeypairSigner(source),
        },
      ],
    });

    const signed = await signInput(
      { kind: "tx", envelope: txEnvelope },
      makeContext({ runtimeSigners: runtime, accountRef: null }),
    );

    expect(signed.report.summary.signed).toBe(1);
    expect(signed.report.details[0]?.target).toBe(`tx:${source.publicKey()}`);
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
});
