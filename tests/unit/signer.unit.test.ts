import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, hash, xdr } from "@stellar/stellar-sdk";
import type { SecretResolver } from "../../src/secrets.js";
import {
  KeypairSigner,
  SshAgentSigner,
  isMppPaymentSigner,
  requireKeypairSigner,
  resolveSigner,
} from "../../src/signer.js";
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

  it("provides x402 auth-entry signing", async () => {
    const authEntry = Buffer.from("keypair-auth-entry");
    const authSigner = signer.authEntrySigner(Networks.TESTNET);

    const signed = await authSigner.signAuthEntry(authEntry.toString("base64"));

    expect(authSigner.address).toBe(keypair.publicKey());
    expect(signed.signerAddress).toBe(keypair.publicKey());
    expect(keypair.verify(hash(authEntry), Buffer.from(signed.signedAuthEntry, "base64"))).toBe(
      true,
    );
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

  it("provides x402 auth-entry signing", async () => {
    fixture = await makeFakeSshAgentFixture();
    const signer = await buildSshAgentSigner(fixture);
    const authEntry = Buffer.from("ssh-agent-auth-entry");
    const authSigner = signer.authEntrySigner(Networks.TESTNET);

    const signed = await authSigner.signAuthEntry(authEntry.toString("base64"));

    expect(authSigner.address).toBe(fixture.stellarAddress);
    expect(signed.signerAddress).toBe(fixture.stellarAddress);
    expect(
      fixture.keypair.verify(hash(authEntry), Buffer.from(signed.signedAuthEntry, "base64")),
    ).toBe(true);
  });
});

describe("resolveSigner()", () => {
  let fixture: FakeSshAgentFixture;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
  });

  it("resolves provider-backed seeds and exposes their signer capabilities", async () => {
    const keypair = Keypair.random();
    const resolve = vi.fn().mockResolvedValue(keypair.secret());
    const resolver = { resolve } as unknown as SecretResolver;

    const signer = await resolveSigner("keychain://wallet/signer", resolver);

    expect(resolve).toHaveBeenCalledWith("keychain://wallet/signer");
    expect(signer.publicKey()).toBe(keypair.publicKey());
    expect(isMppPaymentSigner(signer)).toBe(true);
    const keypairSigner = requireKeypairSigner(signer, "keypair required");
    expect(keypairSigner.secretSeed()).toBe(keypair.secret());
    expect(keypairSigner.keypair().publicKey()).toBe(keypair.publicKey());
  });

  it("maps invalid provider values to the caller's error", async () => {
    const resolver = {
      resolve: vi.fn().mockResolvedValue("not-a-seed"),
    } as unknown as SecretResolver;

    await expect(
      resolveSigner("keychain://wallet/signer", resolver, "credential must be a seed"),
    ).rejects.toThrow("credential must be a seed");
  });

  it("preserves provider errors", async () => {
    const resolver = {
      resolve: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    } as unknown as SecretResolver;

    await expect(resolveSigner("keychain://wallet/signer", resolver)).rejects.toThrow(
      "provider unavailable",
    );
  });

  it("resolves ssh-agent refs without calling the secret resolver", async () => {
    fixture = await makeFakeSshAgentFixture();
    const ref = `ssh-agent://custom/${fixture.stellarAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;
    const resolve = vi.fn();

    const signer = await resolveSigner(ref, { resolve } as unknown as SecretResolver);

    expect(signer).toBeInstanceOf(SshAgentSigner);
    expect(signer.publicKey()).toBe(fixture.stellarAddress);
    expect(signer.rawPublicKey().length).toBe(32);
    expect(signer.rawPublicKey().equals(Buffer.from(fixture.keypair.rawPublicKey()))).toBe(true);
    expect(resolve).not.toHaveBeenCalled();

    const data = hash(Buffer.from("create-signer-test"));
    const sig = await signer.sign(data);
    expect(sig.length).toBe(64);
    expect(fixture.keypair.verify(data, sig)).toBe(true);

    expect(isMppPaymentSigner(signer)).toBe(false);
    expect(() => requireKeypairSigner(signer, "keypair required")).toThrow("keypair required");
  });

  it("reports a missing ssh-agent identity", async () => {
    fixture = await makeFakeSshAgentFixture();
    const unknownAddress = Keypair.random().publicKey();
    const ref = `ssh-agent://custom/${unknownAddress}?socket=${encodeURIComponent(fixture.socketPath)}`;

    await expect(
      resolveSigner(ref, { resolve: vi.fn() } as unknown as SecretResolver),
    ).rejects.toThrow(/No Ed25519 key matching .+ found in SSH agent/);
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
