import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { SecretResolver } from "../../src/secrets.js";
import { submitTxXdrViaRpc, submitViaChannels } from "../../src/submit.js";

describe("submit unit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires channels base URL", async () => {
    await expect(
      submitViaChannels(
        { kind: "tx", envelope: { toXDR: () => "AAAA" } } as never,
        { rpc_url: "https://rpc.invalid", network_passphrase: Networks.TESTNET },
        new SecretResolver("op"),
        {},
      ),
    ).rejects.toThrow(/Channels base URL is required/i);
  });

  it("requires channels API key", async () => {
    await expect(
      submitViaChannels(
        { kind: "tx", envelope: { toXDR: () => "AAAA" } } as never,
        {
          rpc_url: "https://rpc.invalid",
          network_passphrase: Networks.TESTNET,
          channels_base_url: "https://channels.example",
        },
        new SecretResolver("op"),
        {},
      ),
    ).rejects.toThrow(/Channels API key is required/i);
  });

  it("supports non-op channelsApiKeyRef and pluginId", async () => {
    const submitTxSpy = vi.spyOn(ChannelsClient.prototype, "submitTransaction").mockResolvedValue({
      hash: "tx-hash",
      status: "pending",
      transactionId: "tx-id",
    } as never);

    const result = await submitViaChannels(
      { kind: "tx", envelope: { toXDR: () => "AAAA" } } as never,
      {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
      },
      new SecretResolver("op"),
      {
        channelsApiKeyRef: "direct-api-key",
        pluginId: "plugin-1",
      },
    );

    expect(result.mode).toBe("channels");
    expect(result.request_kind).toBe("tx");
    expect(submitTxSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves supported secret refs from override and network config", async () => {
    vi.spyOn(ChannelsClient.prototype, "submitTransaction").mockResolvedValue({
      hash: "tx-hash",
      status: "confirmed",
      transactionId: "tx-id",
    } as never);
    const resolver = new SecretResolver("op");
    const resolveSpy = vi.spyOn(resolver, "resolve").mockResolvedValue("resolved-key");

    await submitViaChannels(
      { kind: "tx", envelope: { toXDR: () => "AAAA" } } as never,
      {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
      },
      resolver,
      { channelsApiKeyRef: "op://vault/item/key" },
    );
    expect(resolveSpy).toHaveBeenCalledWith("op://vault/item/key");

    await submitViaChannels(
      { kind: "tx", envelope: { toXDR: () => "BBBB" } } as never,
      {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
        channels_api_key_ref: "op://vault/item/network_key",
      },
      resolver,
      {},
    );
    expect(resolveSpy).toHaveBeenCalledWith("op://vault/item/network_key");

    await submitViaChannels(
      { kind: "tx", envelope: { toXDR: () => "CCCC" } } as never,
      {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
      },
      resolver,
      { channelsApiKeyRef: "keychain://walleterm-testnet/channels_api_key" },
    );
    expect(resolveSpy).toHaveBeenCalledWith("keychain://walleterm-testnet/channels_api_key");
  });

  it("handles bundle and auth submission validation", async () => {
    await expect(
      submitViaChannels(
        { kind: "bundle", func: undefined, auth: [] } as never,
        {
          rpc_url: "https://rpc.invalid",
          network_passphrase: Networks.TESTNET,
          channels_base_url: "https://channels.example",
        },
        new SecretResolver("op"),
        { channelsApiKey: "k" },
      ),
    ).rejects.toThrow(/requires 'func'/i);

    const submitBundleSpy = vi
      .spyOn(ChannelsClient.prototype, "submitSorobanTransaction")
      .mockResolvedValue({
        hash: "bundle-hash",
        status: "pending",
        transactionId: "bundle-id",
      } as never);

    const bundleResult = await submitViaChannels(
      {
        kind: "bundle",
        func: "AAAA",
        auth: [{ toXDR: () => "AUTH1" }, { toXDR: () => "AUTH2" }],
      } as never,
      {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
      },
      new SecretResolver("op"),
      { channelsApiKey: "k" },
    );
    expect(bundleResult.request_kind).toBe("bundle");
    expect(submitBundleSpy).toHaveBeenCalledTimes(1);

    await expect(
      submitViaChannels(
        { kind: "auth", auth: [{ toXDR: () => "AUTH1" }] } as never,
        {
          rpc_url: "https://rpc.invalid",
          network_passphrase: Networks.TESTNET,
          channels_base_url: "https://channels.example",
        },
        new SecretResolver("op"),
        { channelsApiKey: "k" },
      ),
    ).rejects.toThrow(/standalone auth entry is not supported/i);
  });

  it("submits signed tx xdr directly to rpc", async () => {
    const source = Keypair.random();
    const contract = StrKey.encodeContract(Buffer.alloc(32, 11));
    const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract,
          function: "transfer",
          args: [],
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(source);

    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "SUCCESS",
      hash: "rpc-hash",
      latestLedger: 123,
      latestLedgerCloseTime: 456,
    } as never);

    const out = await submitTxXdrViaRpc(tx.toXDR(), {
      rpc_url: "https://rpc.invalid",
      network_passphrase: Networks.TESTNET,
    });

    expect(out).toEqual({
      status: "SUCCESS",
      hash: "rpc-hash",
      latestLedger: 123,
      latestLedgerCloseTime: 456,
    });
  });
});
