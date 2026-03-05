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
import type { NetworkConfig } from "../../src/config.js";
import {
  createWalletDeployTx,
  deriveContractIdFromSalt,
  discoverContractsByAddress,
  listContractSigners,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
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
        deployer: Keypair.random(),
        wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
        signers: [],
        sequenceOverride: "1",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/At least one signer/i);
  });

  it("validates wasm hash, salt, and sequence inputs", async () => {
    const deployer = Keypair.random();
    const signers: xdr.ScVal[] = [makeDelegatedSignerScVal(Keypair.random().publicKey())];

    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer,
        wasmHashHex: "abcd",
        signers,
        sequenceOverride: "1",
        skipPrepare: true,
      }),
    ).rejects.toThrow(/wasm-hash/i);

    await expect(
      createWalletDeployTx({
        network: TESTNET_NETWORK,
        deployer,
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
        deployer,
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
      deployer,
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
      deployer,
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
      deployer,
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
      deployer,
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
      deployer,
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
        ) as never,
    );

    const out = await createWalletDeployTx({
      network: TESTNET_NETWORK,
      deployer,
      wasmHashHex: "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e",
      signers,
      sequenceOverride: "1",
      skipPrepare: false,
    });

    const parsed = xdr.TransactionEnvelope.fromXDR(out.txXdr, "base64");
    expect(parsed.switch().name).toBe("envelopeTypeTxFeeBump");
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
    await expect(listContractSigners(base, "CABC")).rejects.toThrow(/Indexer request failed/i);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("aborts indexer discovery requests after timeout", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn((_: unknown, init?: RequestInit) => {
          const signal = init?.signal as AbortSignal | undefined;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        }),
      );

      const pending = discoverContractsByAddress("https://indexer.invalid", "GABC").catch(
        (error: unknown) => error as Error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/aborted/i);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
