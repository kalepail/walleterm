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
import type { ChannelsTransactionResponse } from "@openzeppelin/relayer-plugin-channels";
import type { NetworkConfig, WalletermConfig } from "../../src/config.js";
import { SecretResolver } from "../../src/secrets.js";
import { submitConfiguredInput } from "../../src/submit.js";

const TX_INPUT = { kind: "tx", envelope: { toXDR: () => "AAAA" } } as const;
const BUNDLE_WITHOUT_FUNC = { kind: "bundle", func: undefined, auth: [] } as const;
const BUNDLE_WITH_FUNC = {
  kind: "bundle",
  func: "AAAA",
  auth: [{ toXDR: () => "AUTH1" }, { toXDR: () => "AUTH2" }],
} as const;
const AUTH_INPUT = { kind: "auth", auth: [{ toXDR: () => "AUTH1" }] } as const;

function makeConfig(
  defaultSubmitMode = "sign-only",
  network: Partial<NetworkConfig> = {},
): WalletermConfig {
  return {
    app: {
      default_network: "testnet",
      default_submit_mode: defaultSubmitMode,
    },
    networks: {
      testnet: {
        rpc_url: "https://rpc.invalid",
        network_passphrase: Networks.TESTNET,
        channels_base_url: "https://channels.example",
        ...network,
      },
    },
    smart_accounts: {},
  };
}

describe("configured submission interface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps configured submission disabled in sign-only mode", async () => {
    const channelsSpy = vi.spyOn(ChannelsClient.prototype, "submitTransaction");
    const rpcSpy = vi.spyOn(rpc.Server.prototype, "sendTransaction");

    const result = await submitConfiguredInput({
      config: makeConfig(),
      input: TX_INPUT as any,
      trigger: "configured",
      channels: { channelsApiKey: "key" },
    });

    expect(result).toBeNull();
    expect(channelsSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("applies the configured trigger and normalizes a channels bundle result", async () => {
    const resolveSpy = vi.spyOn(SecretResolver.prototype, "resolve").mockResolvedValue("key");
    const clearSpy = vi.spyOn(SecretResolver.prototype, "clearCache");
    const submitSpy = vi
      .spyOn(ChannelsClient.prototype, "submitSorobanTransaction")
      .mockResolvedValue({
        hash: "bundle-hash",
        status: "pending",
        transactionId: "bundle-id",
      } satisfies ChannelsTransactionResponse);

    const result = await submitConfiguredInput({
      config: makeConfig("channels", {
        channels_api_key_ref: "op://vault/item/network_key",
      }),
      input: BUNDLE_WITH_FUNC as any,
      trigger: "configured",
    });

    expect(resolveSpy).toHaveBeenCalledWith("op://vault/item/network_key");
    expect(submitSpy).toHaveBeenCalledWith({ func: "AAAA", auth: ["AUTH1", "AUTH2"] });
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      mode: "channels",
      request_kind: "bundle",
      hash: "bundle-hash",
      status: "pending",
      transaction_id: "bundle-id",
    });
  });

  it("defaults to channels and applies direct overrides", async () => {
    const submitSpy = vi.spyOn(ChannelsClient.prototype, "submitTransaction").mockResolvedValue({
      hash: "tx-hash",
      status: "confirmed",
      transactionId: "tx-id",
    } satisfies ChannelsTransactionResponse);

    const result = await submitConfiguredInput({
      config: makeConfig(),
      input: TX_INPUT as any,
      channels: {
        channelsBaseUrl: "https://override.example",
        channelsApiKey: "direct-key",
        pluginId: "plugin-1",
      },
    });

    expect(submitSpy).toHaveBeenCalledWith({ xdr: "AAAA" });
    expect(result).toMatchObject({ mode: "channels", request_kind: "tx" });
  });

  it("owns channels configuration errors and always clears credentials", async () => {
    const clearSpy = vi.spyOn(SecretResolver.prototype, "clearCache");

    await expect(
      submitConfiguredInput({
        config: makeConfig("sign-only", { channels_base_url: undefined }),
        input: TX_INPUT as any,
        channels: { channelsApiKey: "key" },
      }),
    ).rejects.toThrow(/Channels base URL is required/i);

    await expect(
      submitConfiguredInput({ config: makeConfig(), input: TX_INPUT as any }),
    ).rejects.toThrow(/Channels API key is required/i);

    await expect(
      submitConfiguredInput({
        config: makeConfig(),
        input: TX_INPUT as any,
        channels: { channelsApiKeyRef: "env://something" },
      }),
    ).rejects.toThrow(/Unsupported secret ref 'env:\/\/something'/);

    expect(clearSpy).toHaveBeenCalledTimes(3);
  });

  it("clears credentials when the channels adapter fails", async () => {
    vi.spyOn(ChannelsClient.prototype, "submitTransaction").mockRejectedValue(
      new Error("channels failed"),
    );
    const clearSpy = vi.spyOn(SecretResolver.prototype, "clearCache");

    await expect(
      submitConfiguredInput({
        config: makeConfig(),
        input: TX_INPUT as any,
        channels: { channelsApiKey: "key" },
      }),
    ).rejects.toThrow(/channels failed/i);
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it("enforces mode and input limits", async () => {
    const config = makeConfig();

    await expect(
      submitConfiguredInput({ config, input: BUNDLE_WITH_FUNC as any, mode: "rpc" }),
    ).rejects.toThrow(/RPC submission currently supports signed tx envelope input only/i);
    await expect(
      submitConfiguredInput({
        config,
        input: BUNDLE_WITHOUT_FUNC as any,
        channels: { channelsApiKey: "key" },
      }),
    ).rejects.toThrow(/requires 'func'/i);
    await expect(
      submitConfiguredInput({
        config,
        input: AUTH_INPUT as any,
        channels: { channelsApiKey: "key" },
      }),
    ).rejects.toThrow(/standalone auth entry is not supported/i);
    await expect(
      submitConfiguredInput({ config, input: TX_INPUT as any, mode: "other" }),
    ).rejects.toThrow(/Unsupported submit mode 'other'/i);
  });

  it("normalizes direct rpc submission", async () => {
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
    } as any);

    const result = await submitConfiguredInput({
      config: makeConfig(),
      input: { kind: "signed-tx", xdr: tx.toXDR() },
      mode: "rpc",
    });

    expect(result).toEqual({
      mode: "rpc",
      request_kind: "tx",
      status: "SUCCESS",
      hash: "rpc-hash",
      latestLedger: 123,
      latestLedgerCloseTime: 456,
    });
  });
});
