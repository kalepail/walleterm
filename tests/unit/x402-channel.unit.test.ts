import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, Networks, rpc, StrKey } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeypairSigner } from "../../src/signer.js";
import { executeX402ChannelRequest } from "../../src/x402-channel.js";
import { resolveStoredChannelByKey, upsertStoredChannel } from "../../src/x402-channel/storage.js";
import { makeChannelContextKey, normalizeChannelOffer } from "../../src/x402-channel/protocol.js";

function makeTempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "walleterm-x402-channel-"));
  const path = join(dir, "walleterm.toml");
  writeFileSync(
    path,
    "[app]\ndefault_network='testnet'\n[networks.testnet]\nrpc_url='https://rpc.example'\nnetwork_passphrase='Test SDF Network ; September 2015'\n",
  );
  return path;
}

function makeJsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeBytesResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("executeX402ChannelRequest", () => {
  const getAccountSpy = vi.spyOn(rpc.Server.prototype, "getAccount");
  const prepareTransactionSpy = vi.spyOn(rpc.Server.prototype, "prepareTransaction");

  beforeEach(() => {
    getAccountSpy.mockReset();
    prepareTransactionSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes through non-402 responses without attempting payment", async () => {
    const result = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath: makeTempConfigPath(),
      schemeSelection: "channel",
      payerKeypair: new KeypairSigner(Keypair.random()),
      commitmentKeypair: new KeypairSigner(Keypair.random()),
      fetchFn: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });

    expect(result.kind).toBe("channel");
    if (result.kind !== "channel") throw new Error("unexpected result kind");
    expect(result.paid).toBe(false);
    expect(new TextDecoder().decode(result.body)).toBe("ok");
  });

  it("returns fallback-exact in auto mode when no channel offer is advertised", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 8)),
          amount: "10",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
        },
      ],
    };

    const fetchFn = vi.fn().mockResolvedValue(
      makeJsonResponse(paymentRequired, 402, {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64"),
      }),
    );

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "auto",
        payerKeypair: new KeypairSigner(Keypair.random()),
        commitmentKeypair: new KeypairSigner(Keypair.random()),
        fetchFn,
      }),
    ).resolves.toEqual({ kind: "fallback-exact" });
  });

  it('errors when scheme "channel" is forced but the server does not advertise it', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 8)),
          amount: "10",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
        },
      ],
    };

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: new KeypairSigner(Keypair.random()),
        commitmentKeypair: new KeypairSigner(Keypair.random()),
        fetchFn: vi.fn().mockImplementation(async () =>
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        ),
      }),
    ).rejects.toThrow(/no matching x402 payment option/i);
  });

  it("returns the parsed payment requirements in dry-run mode", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 12)),
          amount: "10",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
          extra: { suggestedDeposit: "1000" },
        },
      ],
    };

    const result = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath: makeTempConfigPath(),
      schemeSelection: "channel",
      payerKeypair: new KeypairSigner(Keypair.random()),
      commitmentKeypair: new KeypairSigner(Keypair.random()),
      dryRun: true,
      fetchFn: vi.fn().mockResolvedValue(
        makeJsonResponse(paymentRequired, 402, {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
            "base64",
          ),
        }),
      ),
    });

    expect(result.kind).toBe("channel");
    if (result.kind !== "channel") throw new Error("unexpected result kind");
    expect(result.paid).toBe(false);
    expect(result.paymentRequired).toEqual(paymentRequired);
  });

  it("opens then immediately pays when the real state-channel flow is selected", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const channelContract = StrKey.encodeContract(Buffer.alloc(32, 9));
    const channelId = "ab".repeat(32);
    const configPath = makeTempConfigPath();

    getAccountSpy.mockResolvedValue(new Account(payer.publicKey(), "1"));
    prepareTransactionSpy.mockImplementation(
      async (tx) => tx as Awaited<ReturnType<(typeof rpc.Server.prototype)["prepareTransaction"]>>,
    );

    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 3)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: {
            channelContract,
            serverPublicKey: Keypair.random().publicKey(),
            suggestedDeposit: "1000",
          },
        },
      ],
    };

    const fetchFn = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        makeJsonResponse(paymentRequired, 402, {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
            "base64",
          ),
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const payload = JSON.parse(
          Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"),
        ) as Record<string, unknown>;
        expect((payload.payload as Record<string, unknown>).action).toBe("open");
        expect((payload.payload as Record<string, unknown>).initialStateSignature).toBeTruthy();
        return makeJsonResponse(
          {
            success: true,
            channelId,
            transaction: "tx-open",
            deposit: "1000",
            iteration: "0",
            currentCumulative: "0",
            remainingBalance: "1000",
            serverSig: "server-sig-0",
            resourceGranted: false,
          },
          200,
          {
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                channelId,
                transaction: "tx-open",
                deposit: "1000",
                iteration: "0",
                currentCumulative: "0",
                remainingBalance: "1000",
                serverSig: "server-sig-0",
                resourceGranted: false,
              }),
              "utf8",
            ).toString("base64"),
          },
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const payload = JSON.parse(
          Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"),
        ) as Record<string, unknown>;
        expect((payload.payload as Record<string, unknown>).action).toBe("pay");
        expect((payload.payload as Record<string, unknown>).iteration).toBe("1");
        return makeBytesResponse("paid resource", 200, {
          "content-type": "text/plain",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({
              success: true,
              channelId,
              iteration: "1",
              currentCumulative: "10",
              remainingBalance: "990",
              serverSig: "server-sig-1",
            }),
            "utf8",
          ).toString("base64"),
        });
      });

    const result = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath,
      schemeSelection: "channel",
      payerKeypair: payer,
      commitmentKeypair: commitment,
      dryRun: false,
      yes: false,
      fetchFn,
    });

    expect(result.kind).toBe("channel");
    if (result.kind !== "channel") throw new Error("unexpected result kind");
    expect(new TextDecoder().decode(result.body)).toBe("paid resource");
    expect(result.channel).toEqual(
      expect.objectContaining({
        action: "open+pay",
        channel_id: channelId,
        current_cumulative: "10",
        remaining_balance: "990",
        mode: "state",
      }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("requires a deposit when opening a state channel without defaults", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 14)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: {
            channelContract: StrKey.encodeContract(Buffer.alloc(32, 15)),
            serverPublicKey: Keypair.random().publicKey(),
          },
        },
      ],
    };

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        fetchFn: vi.fn().mockResolvedValue(
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        ),
      }),
    ).rejects.toThrow(/x402 channel deposit is required/i);
  });

  it("closes an exhausted state channel before reopening and paying", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const channelContract = StrKey.encodeContract(Buffer.alloc(32, 16));
    const configPath = makeTempConfigPath();
    const statePath = join(tmpdir(), `walleterm-x402-state-${Date.now()}-${Math.random()}.json`);
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet" as const,
          asset: StrKey.encodeContract(Buffer.alloc(32, 17)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: {
            channelContract,
            serverPublicKey: Keypair.random().publicKey(),
            suggestedDeposit: "100",
          },
        },
      ],
    };
    const offer = normalizeChannelOffer(
      paymentRequired.accepts[0]! as Parameters<typeof normalizeChannelOffer>[0],
    );
    const contextKey = makeChannelContextKey(
      "https://example.com/resource",
      "testnet",
      offer,
      payer.publicKey(),
    );
    upsertStoredChannel(statePath, {
      channel_id: "11".repeat(32),
      channel_context_key: contextKey,
      network_name: "testnet",
      network_passphrase: Networks.TESTNET,
      resource_origin: "https://example.com",
      resource_pathname: "/resource",
      asset: paymentRequired.accepts[0]!.asset,
      pay_to: payer.publicKey(),
      payer_public_key: payer.publicKey(),
      commitment_public_key: commitment.publicKey(),
      channel_contract_id: channelContract,
      server_public_key: paymentRequired.accepts[0]!.extra.serverPublicKey as string,
      price_per_request: "10",
      deposit: "20",
      current_cumulative: "15",
      remaining_balance: "5",
      current_iteration: "1",
      mode: "state",
      lifecycle_state: "open",
      updated_at: new Date().toISOString(),
    });

    getAccountSpy.mockResolvedValue(new Account(payer.publicKey(), "1"));
    prepareTransactionSpy.mockImplementation(
      async (tx) => tx as Awaited<ReturnType<(typeof rpc.Server.prototype)["prepareTransaction"]>>,
    );

    const fetchFn = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        makeJsonResponse(paymentRequired, 402, {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
            "base64",
          ),
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const payload = JSON.parse(
          Buffer.from(
            ((init?.headers ?? {}) as Record<string, string>)["PAYMENT-SIGNATURE"],
            "base64",
          ).toString("utf8"),
        ) as Record<string, unknown>;
        expect((payload.payload as Record<string, unknown>).action).toBe("close");
        return makeJsonResponse({ success: true, transaction: "tx-close" }, 200, {
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({ success: true, transaction: "tx-close" }),
            "utf8",
          ).toString("base64"),
        });
      })
      .mockImplementationOnce(async (_input, init) => {
        const payload = JSON.parse(
          Buffer.from(
            ((init?.headers ?? {}) as Record<string, string>)["PAYMENT-SIGNATURE"],
            "base64",
          ).toString("utf8"),
        ) as Record<string, unknown>;
        expect((payload.payload as Record<string, unknown>).action).toBe("open");
        return makeJsonResponse(
          {
            success: true,
            channelId: "22".repeat(32),
            transaction: "tx-open",
            deposit: "100",
            iteration: "0",
            currentCumulative: "0",
            remainingBalance: "100",
          },
          200,
          {
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                channelId: "22".repeat(32),
                transaction: "tx-open",
                deposit: "100",
                iteration: "0",
                currentCumulative: "0",
                remainingBalance: "100",
              }),
              "utf8",
            ).toString("base64"),
          },
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        const payload = JSON.parse(
          Buffer.from(
            ((init?.headers ?? {}) as Record<string, string>)["PAYMENT-SIGNATURE"],
            "base64",
          ).toString("utf8"),
        ) as Record<string, unknown>;
        expect((payload.payload as Record<string, unknown>).action).toBe("pay");
        return makeBytesResponse("reopened paid resource", 200, {
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({
              success: true,
              channelId: "22".repeat(32),
              currentCumulative: "10",
              remainingBalance: "90",
              iteration: "1",
            }),
            "utf8",
          ).toString("base64"),
        });
      });

    const result = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath,
      statePathOverride: statePath,
      schemeSelection: "channel",
      payerKeypair: payer,
      commitmentKeypair: commitment,
      fetchFn,
    });

    expect(result.kind).toBe("channel");
    if (result.kind !== "channel") throw new Error("unexpected result kind");
    expect(result.channel).toEqual(
      expect.objectContaining({
        action: "open+pay",
        channel_id: "22".repeat(32),
        remaining_balance: "90",
      }),
    );
    expect(resolveStoredChannelByKey(statePath, contextKey)?.channel_id).toBe("22".repeat(32));
  });

  it("surfaces state-channel close, open, and pay errors", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const channelContract = StrKey.encodeContract(Buffer.alloc(32, 18));
    const accepted = {
      scheme: "channel",
      network: "stellar:testnet",
      asset: StrKey.encodeContract(Buffer.alloc(32, 19)),
      amount: "10",
      payTo: payer.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {
        channelContract,
        serverPublicKey: Keypair.random().publicKey(),
        suggestedDeposit: "100",
      },
    };
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [accepted],
    };

    getAccountSpy.mockResolvedValue(new Account(payer.publicKey(), "1"));
    prepareTransactionSpy.mockImplementation(
      async (tx) => tx as Awaited<ReturnType<(typeof rpc.Server.prototype)["prepareTransaction"]>>,
    );

    const makeInitial402 = () =>
      makeJsonResponse(paymentRequired, 402, {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64"),
      });

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        fetchFn: vi
          .fn()
          .mockResolvedValueOnce(makeInitial402())
          .mockResolvedValueOnce(
            makeJsonResponse({ error: "open denied" }, 403, {
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ error: "open denied" }),
                "utf8",
              ).toString("base64"),
            }),
          ),
      }),
    ).rejects.toThrow(/open denied/i);

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        fetchFn: vi
          .fn()
          .mockResolvedValueOnce(makeInitial402())
          .mockResolvedValueOnce(makeJsonResponse({ success: true }, 200)),
      }),
    ).rejects.toThrow(/did not include channelId/i);

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        fetchFn: vi
          .fn()
          .mockResolvedValueOnce(makeInitial402())
          .mockResolvedValueOnce(
            makeJsonResponse(
              {
                success: true,
                channelId: "33".repeat(32),
                deposit: "100",
                currentCumulative: "0",
                remainingBalance: "100",
                iteration: "0",
              },
              200,
            ),
          )
          .mockResolvedValueOnce(makeJsonResponse({ error: "pay denied" }, 409)),
      }),
    ).rejects.toThrow(/pay denied/i);
  });

  it("executes demo-channel payments and reuses stored channel state", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const configPath = makeTempConfigPath();
    const statePath = join(tmpdir(), `walleterm-x402-demo-${Date.now()}.json`);
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 4)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { suggestedDeposit: "100" },
        },
      ],
    };

    const makeFetch = () =>
      vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        )
        .mockImplementationOnce(async (_input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const payload = JSON.parse(
            Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"),
          ) as Record<string, unknown>;
          expect((payload.payload as Record<string, unknown>).mode).toBe("stateless-demo");
          return makeBytesResponse("paid demo resource", 200, {
            "content-type": "text/plain",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                channelId: "demo-channel",
                currentCumulative: "10",
                remainingBalance: "90",
              }),
              "utf8",
            ).toString("base64"),
          });
        });

    const first = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath,
      statePathOverride: statePath,
      schemeSelection: "channel",
      payerKeypair: payer,
      commitmentKeypair: commitment,
      fetchFn: makeFetch(),
    });
    expect(first.kind).toBe("channel");
    if (first.kind !== "channel") throw new Error("unexpected result kind");
    expect(first.channel).toEqual(
      expect.objectContaining({
        action: "open+pay",
        current_cumulative: "10",
        remaining_balance: "90",
        mode: "demo",
      }),
    );

    const second = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath,
      statePathOverride: statePath,
      schemeSelection: "channel",
      payerKeypair: payer,
      commitmentKeypair: commitment,
      fetchFn: makeFetch(),
    });
    expect(second.kind).toBe("channel");
    if (second.kind !== "channel") throw new Error("unexpected result kind");
    expect(second.channel).toEqual(
      expect.objectContaining({
        action: "pay",
        current_cumulative: "20",
        remaining_balance: "80",
        mode: "demo",
      }),
    );
  });

  it("rejects demo-channel deposits that exceed the configured cap", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 5)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { suggestedDeposit: "1000" },
        },
      ],
    };

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        channelConfig: { max_deposit_amount: "100" },
        fetchFn: vi.fn().mockResolvedValue(
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        ),
      }),
    ).rejects.toThrow(/exceeds configured max_deposit_amount/i);
  });

  it("defaults demo-channel deposits to 100x the request price when none is advertised", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const statePath = join(tmpdir(), `walleterm-x402-demo-${Date.now()}-default-deposit.json`);
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 6)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
        },
      ],
    };

    const result = await executeX402ChannelRequest({
      url: "https://example.com/resource",
      method: "GET",
      x402Network: "stellar:testnet",
      networkName: "testnet",
      networkPassphrase: Networks.TESTNET,
      rpcUrl: "https://rpc.example",
      configPath: makeTempConfigPath(),
      statePathOverride: statePath,
      schemeSelection: "channel",
      payerKeypair: payer,
      commitmentKeypair: commitment,
      fetchFn: vi
        .fn()
        .mockImplementationOnce(async () =>
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        )
        .mockImplementationOnce(async (_input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          const payload = JSON.parse(
            Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf8"),
          ) as Record<string, unknown>;
          expect((payload.payload as Record<string, unknown>).deposit).toBe("1000");
          return makeBytesResponse("paid demo resource", 200, {
            "content-type": "text/plain",
          });
        }),
    });

    expect(result.kind).toBe("channel");
    if (result.kind !== "channel") throw new Error("unexpected result kind");
    expect(result.channel).toEqual(
      expect.objectContaining({
        mode: "demo",
        deposit: "1000",
        current_cumulative: "10",
        remaining_balance: "990",
      }),
    );
  });

  it("enforces max payment amount for demo-channel payments", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 7)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { suggestedDeposit: "100" },
        },
      ],
    };

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath: makeTempConfigPath(),
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        maxPaymentAmount: "5",
        fetchFn: vi.fn().mockResolvedValue(
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        ),
      }),
    ).rejects.toThrow(/exceeds configured max_payment_amount/i);
  });

  it("errors when a reused demo channel no longer has enough balance", async () => {
    const payer = new KeypairSigner(Keypair.random());
    const commitment = new KeypairSigner(Keypair.random());
    const configPath = makeTempConfigPath();
    const statePath = join(tmpdir(), `walleterm-x402-demo-${Date.now()}-insufficient.json`);
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/resource", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 8)),
          amount: "10",
          payTo: payer.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { suggestedDeposit: "20" },
        },
      ],
    };
    const offer = normalizeChannelOffer(
      paymentRequired.accepts[0] as Parameters<typeof normalizeChannelOffer>[0],
    );
    if (offer.mode !== "demo") throw new Error("expected demo offer");
    const channelContextKey = makeChannelContextKey(
      "https://example.com/resource",
      "testnet",
      offer,
      payer.publicKey(),
    );
    upsertStoredChannel(statePath, {
      channel_id: "demo-channel",
      channel_context_key: channelContextKey,
      network_name: "testnet",
      network_passphrase: Networks.TESTNET,
      resource_origin: "https://example.com",
      resource_pathname: "/resource",
      asset: offer.asset,
      pay_to: offer.payTo,
      payer_public_key: payer.publicKey(),
      commitment_public_key: commitment.publicKey(),
      server_public_key: offer.serverPublicKey,
      price_per_request: offer.price,
      deposit: "10",
      current_cumulative: "10",
      remaining_balance: "0",
      current_iteration: "1",
      mode: "demo",
      lifecycle_state: "exhausted",
      updated_at: new Date().toISOString(),
    });

    await expect(
      executeX402ChannelRequest({
        url: "https://example.com/resource",
        method: "GET",
        x402Network: "stellar:testnet",
        networkName: "testnet",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "https://rpc.example",
        configPath,
        statePathOverride: statePath,
        schemeSelection: "channel",
        payerKeypair: payer,
        commitmentKeypair: commitment,
        fetchFn: vi.fn().mockImplementation(async () =>
          makeJsonResponse(paymentRequired, 402, {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
              "base64",
            ),
          }),
        ),
      }),
    ).rejects.toThrow(/insufficient for payment amount/i);

    expect(resolveStoredChannelByKey(statePath, channelContextKey)).toEqual(
      expect.objectContaining({
        channel_id: "demo-channel",
        remaining_balance: "0",
        lifecycle_state: "exhausted",
      }),
    );
  });
});
