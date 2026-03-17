import { afterEach, describe, expect, it } from "vitest";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { KeypairSigner, SshAgentSigner, createSshAgentSigner } from "../../src/signer.js";
import { makeFakeSshAgentFixture, type FakeSshAgentFixture } from "../helpers/fake-ssh-agent.js";

function makeTxLike(): { hash(): Buffer; signatures: xdr.DecoratedSignature[] } {
  return {
    hash: () => hash(Buffer.from("test-tx")),
    signatures: [] as xdr.DecoratedSignature[],
  };
}

describe("KeypairSigner", () => {
  const keypair = Keypair.random();
  const signer = new KeypairSigner(keypair);

  it("publicKey() returns G-address matching the keypair", () => {
    const pk = signer.publicKey();
    expect(pk).toBe(keypair.publicKey());
    expect(pk).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it("rawPublicKey() returns 32-byte Buffer matching keypair", () => {
    const raw = signer.rawPublicKey();
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw.length).toBe(32);
    expect(raw.equals(Buffer.from(keypair.rawPublicKey()))).toBe(true);
  });

  it("signatureHint() returns last 4 bytes of raw public key", () => {
    const hint = signer.signatureHint();
    expect(Buffer.isBuffer(hint)).toBe(true);
    expect(hint.length).toBe(4);
    const raw = signer.rawPublicKey();
    expect(hint.equals(raw.subarray(raw.length - 4))).toBe(true);
  });

  it("sign(data) returns 64-byte signature that Keypair.verify accepts", async () => {
    const data = hash(Buffer.from("hello"));
    const sig = await signer.sign(data);
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.length).toBe(64);
    expect(keypair.verify(data, sig)).toBe(true);
  });

  it("signDecorated(data) returns DecoratedSignature with correct hint and signature", async () => {
    const data = hash(Buffer.from("decorated-test"));
    const decorated = await signer.signDecorated(data);
    expect(decorated).toBeInstanceOf(xdr.DecoratedSignature);

    const hint = decorated.hint();
    const sig = decorated.signature();

    expect(Buffer.from(hint).equals(signer.signatureHint())).toBe(true);
    expect(sig.length).toBe(64);
    expect(keypair.verify(data, Buffer.from(sig))).toBe(true);
  });

  it("signTransaction(tx) adds a signature to tx.signatures array", async () => {
    const txLike = makeTxLike();
    expect(txLike.signatures).toHaveLength(0);

    await signer.signTransaction(txLike);

    expect(txLike.signatures).toHaveLength(1);
    const decorated = txLike.signatures[0]!;
    expect(decorated).toBeInstanceOf(xdr.DecoratedSignature);

    const txHash = txLike.hash();
    expect(keypair.verify(txHash, Buffer.from(decorated.signature()))).toBe(true);
    expect(Buffer.from(decorated.hint()).equals(signer.signatureHint())).toBe(true);
  });
});

describe("SshAgentSigner", () => {
  let fixture: FakeSshAgentFixture;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
  });

  it("publicKey() returns the configured stellar address", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const pk = signer.publicKey();
    expect(pk).toBe(fixture.stellarAddress);
    expect(pk).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it("rawPublicKey() returns the 32-byte key", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const raw = signer.rawPublicKey();
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw.length).toBe(32);
    expect(raw.equals(Buffer.from(fixture.keypair.rawPublicKey()))).toBe(true);
  });

  it("signatureHint() returns last 4 bytes", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const hint = signer.signatureHint();
    expect(Buffer.isBuffer(hint)).toBe(true);
    expect(hint.length).toBe(4);

    const raw = signer.rawPublicKey();
    expect(hint.equals(raw.subarray(raw.length - 4))).toBe(true);
  });

  it("sign(data) returns valid Ed25519 signature verifiable against the keypair", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const data = hash(Buffer.from("ssh-agent-sign-test"));
    const sig = await signer.sign(data);

    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.length).toBe(64);
    expect(fixture.keypair.verify(data, sig)).toBe(true);
  });

  it("signDecorated(data) returns correct DecoratedSignature", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const data = hash(Buffer.from("ssh-agent-decorated-test"));
    const decorated = await signer.signDecorated(data);

    expect(decorated).toBeInstanceOf(xdr.DecoratedSignature);

    const hint = decorated.hint();
    const sig = decorated.signature();

    expect(Buffer.from(hint).equals(signer.signatureHint())).toBe(true);
    expect(sig.length).toBe(64);
    expect(fixture.keypair.verify(data, Buffer.from(sig))).toBe(true);
  });

  it("signTransaction(tx) adds a valid signature", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);

    const txLike = makeTxLike();
    expect(txLike.signatures).toHaveLength(0);

    await signer.signTransaction(txLike);

    expect(txLike.signatures).toHaveLength(1);
    const decorated = txLike.signatures[0]!;
    expect(decorated).toBeInstanceOf(xdr.DecoratedSignature);

    const txHash = txLike.hash();
    expect(fixture.keypair.verify(txHash, Buffer.from(decorated.signature()))).toBe(true);
    expect(Buffer.from(decorated.hint()).equals(signer.signatureHint())).toBe(true);
  });
});

describe("createSshAgentSigner()", () => {
  let fixture: FakeSshAgentFixture;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
  });

  it("creates signer from valid ssh-agent:// ref using fake agent", async () => {
    fixture = await makeFakeSshAgentFixture();
    const ref = `ssh-agent://custom/${fixture.stellarAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;

    const signer = await createSshAgentSigner(ref);

    expect(signer).toBeInstanceOf(SshAgentSigner);
    expect(signer.publicKey()).toBe(fixture.stellarAddress);
    expect(signer.rawPublicKey().length).toBe(32);
    expect(signer.rawPublicKey().equals(Buffer.from(fixture.keypair.rawPublicKey()))).toBe(true);

    // Verify it can actually sign
    const data = hash(Buffer.from("create-signer-test"));
    const sig = await signer.sign(data);
    expect(sig.length).toBe(64);
    expect(fixture.keypair.verify(data, sig)).toBe(true);
  });

  it("throws when key not found in agent", async () => {
    fixture = await makeFakeSshAgentFixture();
    // Use a different random keypair's address that the agent doesn't know about
    const unknownAddress = Keypair.random().publicKey();
    const ref = `ssh-agent://custom/${unknownAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;

    await expect(createSshAgentSigner(ref)).rejects.toThrow(
      /No Ed25519 key matching .+ found in SSH agent/,
    );
  });
});

/**
 * Helper to build an SshAgentSigner from a fake SSH agent fixture,
 * using findAgentIdentity to get the keyBlob the same way createSshAgentSigner does.
 */
async function buildSshAgentSigner(fixture: FakeSshAgentFixture): Promise<SshAgentSigner> {
  const { findAgentIdentity } = await import("../../src/ssh-agent.js");
  const identity = await findAgentIdentity(fixture.socketPath, fixture.stellarAddress);
  if (!identity) throw new Error("Fixture identity not found in fake agent");

  return new SshAgentSigner(
    fixture.stellarAddress,
    identity.publicKey,
    identity.keyBlob,
    fixture.socketPath,
  );
}
