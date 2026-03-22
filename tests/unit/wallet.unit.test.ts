import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { KeypairSigner } from "../../src/signer.js";
import type { NetworkConfig } from "../../src/config.js";
import {
  createWalletDeployTx,
  discoverContractsByCredentialId,
  deriveContractIdFromSalt,
  discoverContractsByAddress,
  listContractSigners,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
  reconcileContractSigners,
  resolveIndexerUrl,
} from "../../src/wallet.js";

const TESTNET_NETWORK: NetworkConfig = {
  rpc_url: "https://rpc.invalid",
  network_passphrase: Networks.TESTNET,
};

describe("wallet unit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolveIndexerUrl uses override, config, and known passphrase defaults", () => {
    expect(
      resolveIndexerUrl(
        {
          ...TESTNET_NETWORK,
          indexer_url: "https://config-indexer.example",
        },
        "https://override-indexer.example",
      ),
    ).toBe("https://override-indexer.example");
    expect(
      resolveIndexerUrl({
        ...TESTNET_NETWORK,
        indexer_url: "https://config-indexer.example",
      }),
    ).toBe("https://config-indexer.example");
    expect(resolveIndexerUrl(TESTNET_NETWORK)).toContain("smart-account-indexer");
  });

  it("resolveIndexerUrl throws when no indexer can be inferred", () => {
    expect(() =>
      resolveIndexerUrl({
        rpc_url: "https://rpc.invalid",
        network_passphrase: "Unknown Network",
      }),
    ).toThrow(/No indexer URL configured/i);
  });

  it("validates external signer public key hex", () => {
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 2));
    expect(() => makeExternalSignerScVal(verifier, "abc123")).toThrow(/32-byte hex/i);
  });

  it("validates salt length for contract-id derivation", () => {
    const deployer = Keypair.random();
    expect(() =>
      deriveContractIdFromSalt(Networks.TESTNET, deployer.publicKey(), Buffer.alloc(31)),
    ).toThrow(/salt must be 32 bytes/i);
  });

  it("rejects wallet deploy creation with empty signer list", async () => {
    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer: new KeypairSigner(Keypair.random()),
        wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
        signers: [],
        sequenceOverride: "1",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/At least one signer/i);
  });

  it("validates wasm hash, salt, and sequence inputs", async () => {
    const deployer = Keypair.random();
    const deployerSigner = new KeypairSigner(deployer);
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];

    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer: deployerSigner,
        wasmHashHex: "abcd",
        signers,
        sequenceOverride: "1",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/wasm-hash/i);

    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer: deployerSigner,
        wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
        signers,
        saltHex: "abcd",
        sequenceOverride: "1",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/salt-hex/i);

    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer: deployerSigner,
        wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
        signers,
        sequenceOverride: "not-an-int",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/sequence must be an integer string/i);
  });

  it("uses rpc.getAccount when sequenceOverride is omitted", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];
    const getAccountSpy = vi
      .spyOn(rpc.Server.prototype, "getAccount")
      .mockResolvedValue(new Account(deployer.publicKey(), "1"));

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      skipPrepare: true,
    });

    expect(out.contractId.startsWith("C")).toBe(true);
    expect(getAccountSpy).toHaveBeenCalledTimes(1);
  });

  it("calls prepareTransaction when skipPrepare is false", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];
    const prepareSpy = vi
      .spyOn(rpc.Server.prototype, "prepareTransaction")
      .mockImplementation(async (tx) => tx as any);

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      skipPrepare: false,
    });

    expect(out.contractId.startsWith("C")).toBe(true);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes prepared Soroban fee to resource fee by default", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];
    const resourceFee = "150000";

    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) =>
      TransactionBuilder.cloneFrom(tx as any, {
        fee: resourceFee,
        sorobanData: new SorobanDataBuilder().setResourceFee(resourceFee).build(),
      }).build(),
    );

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      skipPrepare: false,
    });

    const tx = TransactionBuilder.fromXDR(out.txXdr, Networks.TESTNET);
    const v1 = tx.toEnvelope().v1().tx();
    expect(v1.ext().sorobanData().resourceFee().toString()).toBe(resourceFee);
    expect(v1.fee().toString()).toBe(resourceFee);
  });

  it("keeps prepared inclusion fee when explicit fee override is provided", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];
    const explicitFee = "777";
    const resourceFee = "150000";

    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) =>
      TransactionBuilder.cloneFrom(tx as any, {
        fee: explicitFee,
        sorobanData: new SorobanDataBuilder().setResourceFee(resourceFee).build(),
      }).build(),
    );

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      fee: explicitFee,
      skipPrepare: false,
    });

    const tx = TransactionBuilder.fromXDR(out.txXdr, Networks.TESTNET);
    const v1 = tx.toEnvelope().v1().tx();
    expect(v1.ext().sorobanData().resourceFee().toString()).toBe(resourceFee);
    expect(v1.fee().toString()).toBe((Number(explicitFee) + Number(resourceFee)).toString());
  });

  it("leaves prepared tx unchanged when fee already equals resource fee", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];
    const resourceFee = "123456";

    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) =>
      TransactionBuilder.cloneFrom(tx as any, {
        fee: "0",
        sorobanData: new SorobanDataBuilder().setResourceFee(resourceFee).build(),
      }).build(),
    );

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      skipPrepare: false,
    });

    const tx = TransactionBuilder.fromXDR(out.txXdr, Networks.TESTNET);
    const v1 = tx.toEnvelope().v1().tx();
    expect(v1.fee().toString()).toBe(resourceFee);
    expect(v1.ext().sorobanData().resourceFee().toString()).toBe(resourceFee);
  });

  it("keeps fee-bump prepare responses unchanged in normalization step", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];

    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(
      async (tx) =>
        TransactionBuilder.buildFeeBumpTransaction(
          Keypair.random(),
          "100",
          tx as any,
          Networks.TESTNET,
        ) as unknown as Awaited<ReturnType<rpc.Server["prepareTransaction"]>>,
    );

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer: new KeypairSigner(deployer),
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      skipPrepare: false,
    });

    const parsed = xdr.TransactionEnvelope.fromXDR(out.txXdr, "base64");
    expect(parsed.switch().name).toBe("envelopeTypeTxFeeBump");
  });

  it("sorts external signers deterministically during reconciliation", () => {
    const reconciliation = reconcileContractSigners(
      {
        network: "testnet",
        contract_id: "CABC",
        delegated_signers: [],
        external_signers: [
          {
            name: "b",
            verifier_contract_id: "CVERB",
            public_key_hex: "bb".repeat(32),
            secret_ref: "op://b",
          },
          {
            name: "a",
            verifier_contract_id: "CVERA",
            public_key_hex: "aa".repeat(32),
            secret_ref: "op://a",
          },
        ],
      },
      [],
      "subset",
    );

    expect(reconciliation.configured.external).toEqual([
      { verifier_contract_id: "CVERA", public_key_hex: "aa".repeat(32) },
      { verifier_contract_id: "CVERB", public_key_hex: "bb".repeat(32) },
    ]);
  });

  it("surfaces indexer non-200 responses for discovery endpoints", async () => {
    const server = createServer((_, res) => {
      res.statusCode = 500;
      res.end("error");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server failed to bind");
    const base = `http://127.0.0.1:${addr.port}`;

    await expect(discoverContractsByAddress(base, "GABC")).rejects.toThrow(
      /Indexer request failed/i,
    );
    await expect(discoverContractsByCredentialId(base, "abc123")).rejects.toThrow(
      /Indexer request failed/i,
    );
    await expect(listContractSigners(base, "CABC")).rejects.toThrow(/Indexer request failed/i);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("surfaces schema parse failures from indexer responses", async () => {
    const server = createServer((_, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ wrong: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server failed to bind");
    const base = `http://127.0.0.1:${addr.port}`;

    await expect(discoverContractsByAddress(base, "GABC")).rejects.toThrow(/.+/);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("aborts indexer discovery requests after timeout", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    try {
      let aborted = false;
      (globalThis as { fetch: typeof fetch }).fetch = vi.fn((_: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      }) as unknown as typeof fetch;

      const pending = discoverContractsByAddress("https://indexer.invalid", "GABC").catch(
        (error: unknown) => error as Error,
      );
      vi.advanceTimersByTime(15_000);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/aborted/i);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });

  it("reconciles configured vs onchain signers in subset and exact modes", () => {
    const account = {
      network: "testnet",
      contract_id: StrKey.encodeContract(Buffer.alloc(32, 9)),
      delegated_signers: [
        { name: "del-a", address: Keypair.random().publicKey(), secret_ref: "op://del-a" },
      ],
      external_signers: [
        {
          name: "ext-a",
          verifier_contract_id: StrKey.encodeContract(Buffer.alloc(32, 7)),
          public_key_hex: Buffer.from(Keypair.random().rawPublicKey())
            .toString("hex")
            .toUpperCase(),
          secret_ref: "op://ext-a",
        },
      ],
    };

    const subset = reconcileContractSigners(
      account,
      [
        {
          context_rule_id: 0,
          signer_type: "Delegated",
          signer_address: account.delegated_signers[0]!.address,
          credential_id: null,
        },
        {
          context_rule_id: 0,
          signer_type: "External",
          signer_address: account.external_signers[0]!.verifier_contract_id,
          credential_id: account.external_signers[0]!.public_key_hex.toLowerCase(),
        },
        {
          context_rule_id: 0,
          signer_type: "Delegated",
          signer_address: Keypair.random().publicKey(),
          credential_id: null,
        },
        {
          context_rule_id: 0,
          signer_type: "Native",
          signer_address: null,
          credential_id: null,
        },
      ],
      "subset",
    );

    expect(subset.ok).toBe(true);
    expect(subset.extra.delegated).toHaveLength(1);
    expect(subset.missing.delegated).toHaveLength(0);

    const exact = reconcileContractSigners(
      account,
      [
        {
          context_rule_id: 0,
          signer_type: "Delegated",
          signer_address: account.delegated_signers[0]!.address,
          credential_id: null,
        },
      ],
      "exact",
    );

    expect(exact.ok).toBe(false);
    expect(exact.missing.external).toEqual([
      {
        verifier_contract_id: account.external_signers[0]!.verifier_contract_id,
        public_key_hex: account.external_signers[0]!.public_key_hex.toLowerCase(),
      },
    ]);
  });

  it("reconciles exact mode successfully when config and onchain signers match", () => {
    const delegated = Keypair.random().publicKey();
    const verifier = StrKey.encodeContract(Buffer.alloc(32, 7));
    const publicKeyHex = Buffer.from(Keypair.random().rawPublicKey()).toString("hex");

    const reconciliation = reconcileContractSigners(
      {
        network: "testnet",
        contract_id: StrKey.encodeContract(Buffer.alloc(32, 9)),
        delegated_signers: [{ name: "del", address: delegated, secret_ref: "op://del" }],
        external_signers: [
          {
            name: "ext",
            verifier_contract_id: verifier,
            public_key_hex: publicKeyHex,
            secret_ref: "op://ext",
          },
        ],
      },
      [
        {
          context_rule_id: 0,
          signer_type: "Delegated",
          signer_address: delegated,
          credential_id: null,
        },
        {
          context_rule_id: 0,
          signer_type: "External",
          signer_address: verifier,
          credential_id: publicKeyHex,
        },
      ],
      "exact",
    );

    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.extra.delegated).toEqual([]);
    expect(reconciliation.extra.external).toEqual([]);
  });

  it("handles omitted signer arrays and exact-mode extra signers", () => {
    const extraDelegated = Keypair.random().publicKey();
    const extraVerifier = StrKey.encodeContract(Buffer.alloc(32, 5));
    const extraPublicKey = "aa".repeat(32);

    const empty = reconcileContractSigners(
      {
        network: "testnet",
        contract_id: "CABC",
      },
      [],
      "subset",
    );
    expect(empty.ok).toBe(true);
    expect(empty.configured.delegated).toEqual([]);
    expect(empty.configured.external).toEqual([]);

    const exactWithExtras = reconcileContractSigners(
      {
        network: "testnet",
        contract_id: "CABC",
      },
      [
        {
          context_rule_id: 0,
          signer_type: "Delegated",
          signer_address: extraDelegated,
          credential_id: null,
        },
        {
          context_rule_id: 0,
          signer_type: "External",
          signer_address: extraVerifier,
          credential_id: extraPublicKey,
        },
      ],
      "exact",
    );

    expect(exactWithExtras.ok).toBe(false);
    expect(exactWithExtras.extra.delegated).toEqual([extraDelegated]);
    expect(exactWithExtras.extra.external).toEqual([
      { verifier_contract_id: extraVerifier, public_key_hex: extraPublicKey },
    ]);
  });
});
