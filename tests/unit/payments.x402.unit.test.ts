import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, Networks, rpc, StrKey } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletermConfig } from "../../src/config.js";
import { executePaymentRequest } from "../../src/payments/index.js";
import { KeypairSigner } from "../../src/signer.js";
import { executeX402Payment } from "../../src/payments/x402.js";
import { SecretResolver } from "../../src/secrets.js";

const { createX402HttpHandlerMock } = vi.hoisted(() => ({
  createX402HttpHandlerMock: vi.fn(),
}));

vi.mock("../../src/payments/mpp.js", () => ({
  executeMppPayment: vi.fn(),
}));

vi.mock("../../src/x402.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/x402.js")>("../../src/x402.js");
  return {
    ...actual,
    passphraseToX402Network: vi.fn(() => "stellar:testnet"),
    createX402HttpHandler: createX402HttpHandlerMock,
  };
});

function makeTempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "walleterm-payments-x402-unit-"));
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

describe("executeX402Payment", () => {
  const getAccountSpy = vi.spyOn(rpc.Server.prototype, "getAccount");
  const prepareTransactionSpy = vi.spyOn(rpc.Server.prototype, "prepareTransaction");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a paid channel result through the payment orchestration layer", async () => {
    const payer = Keypair.random();
    const commitment = Keypair.random();
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
          network: "stellar:testnet",
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

    const result = await executeX402Payment({
      url: "https://example.com/resource",
      method: "GET",
      networkName: "testnet",
      network: {
        rpc_url: "https://rpc.example",
        network_passphrase: Networks.TESTNET,
      },
      payerSigner: new KeypairSigner(payer),
      exactSigner: { address: payer.publicKey(), signAuthEntry: vi.fn() },
      commitmentKeypair: new KeypairSigner(commitment),
      configPath,
      schemeSelection: "channel",
      dryRun: false,
      yes: false,
      fetchFn,
    });

    expect(result.scheme).toBe("channel");
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

  it("reuses the first 402 challenge when auto mode falls back to exact", async () => {
    const payer = Keypair.random();
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
    const paymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0]!,
      payload: { signed: true },
    };
    createX402HttpHandlerMock.mockReturnValue({
      getPaymentRequiredResponse: vi.fn(() => paymentRequired),
      createPaymentPayload: vi.fn(async () => paymentPayload),
      encodePaymentSignatureHeader: vi.fn(() => ({ "PAYMENT-SIGNATURE": "signed-payment" })),
      getPaymentSettleResponse: vi.fn(() => ({ success: true, transaction: "tx-exact" })),
    });

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
        expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE")).toBe("signed-payment");
        return makeBytesResponse("paid resource", 200, {
          "PAYMENT-RESPONSE": "settled-payment",
        });
      });

    const config: WalletermConfig = {
      app: { default_network: "testnet" },
      networks: {},
      smart_accounts: {},
      payments: {
        default_protocol: "x402",
        x402: {
          default_payer_secret_ref: "test://payer",
          default_scheme: "auto",
        },
      },
    };
    const resolver = new SecretResolver({
      providers: [{ scheme: "test", resolve: async () => payer.secret() }],
    });

    const execution = await executePaymentRequest(
      config,
      "testnet",
      { rpc_url: "https://rpc.example", network_passphrase: Networks.TESTNET },
      resolver,
      {
        url: "https://example.com/resource",
        method: "GET",
        rawHeaders: [],
        dryRun: false,
        yes: false,
        fetchFn,
      },
    );

    expect(execution.result.scheme).toBe("exact");
    expect(execution.result.paid).toBe(true);
    expect(new TextDecoder().decode(execution.result.body)).toBe("paid resource");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
