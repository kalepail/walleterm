import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, Networks, rpc, StrKey } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeX402Payment } from "../../src/payments/x402.js";

vi.mock("../../src/x402.js", async () => {
  return {
    passphraseToX402Network: vi.fn(() => "stellar:testnet"),
    createWalletermSigner: vi.fn(() => ({ address: "GMOCK" })),
    createX402HttpHandler: vi.fn(() => ({})),
    executeX402Request: vi.fn(),
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
      keypair: payer,
      commitmentKeypair: commitment,
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
});
