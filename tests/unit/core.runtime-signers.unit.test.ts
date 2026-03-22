import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { ExternalSignerConfig, SmartAccountConfig } from "../../src/config.js";
import { listSignerConfig, loadRuntimeSigners } from "../../src/core.js";
import { makeFakeSshAgentFixture } from "../helpers/fake-ssh-agent.js";
import { CONTRACT, makeResolver } from "../helpers/core-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core runtime signers", () => {
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

      const runtime = await loadRuntimeSigners({ alias: "treasury", account }, makeResolver({}));

      expect(runtime.delegated).toHaveLength(1);
      expect(runtime.delegated[0]!.address).toBe(fx.stellarAddress);
      expect(runtime.allSigners).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });
});
