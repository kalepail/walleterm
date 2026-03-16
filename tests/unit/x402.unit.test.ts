import { Keypair } from "@stellar/stellar-sdk";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import {
  createWalletermSigner,
  createX402HttpHandler,
  executeX402Request,
  passphraseToX402Network,
  type X402HttpHandler,
} from "../../src/x402.js";

function decodeBody(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function makePaymentRequired(
  network: Network = "stellar:testnet",
  scheme = "exact",
): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/resource" },
    accepts: [
      {
        scheme,
        network,
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        amount: "100000",
        payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

function makePaymentPayload(): PaymentPayload {
  return {
    x402Version: 2,
    accepted: makePaymentRequired().accepts[0]!,
    payload: { transaction: "AAAA" },
  };
}

function makeSettleResponse(): SettleResponse {
  return {
    success: true,
    transaction: "txhash123",
    network: "stellar:testnet" as Network,
    payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  };
}

function makeMockHandler(overrides?: Partial<X402HttpHandler>): X402HttpHandler {
  return {
    getPaymentRequiredResponse: vi.fn((getHeader: (name: string) => string | null | undefined) => {
      getHeader("PAYMENT-REQUIRED");
      return makePaymentRequired();
    }),
    createPaymentPayload: vi.fn(async () => makePaymentPayload()),
    encodePaymentSignatureHeader: vi.fn(() => ({
      "PAYMENT-SIGNATURE": "base64encodedpayload",
    })),
    getPaymentSettleResponse: vi.fn((getHeader: (name: string) => string | null | undefined) => {
      getHeader("PAYMENT-RESPONSE");
      return makeSettleResponse();
    }),
    ...overrides,
  };
}

function mockFetch(status: number, body: string, headers?: Record<string, string>) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

describe("passphraseToX402Network", () => {
  it("maps testnet passphrase", () => {
    expect(passphraseToX402Network("Test SDF Network ; September 2015")).toBe("stellar:testnet");
  });

  it("maps pubnet passphrase", () => {
    expect(passphraseToX402Network("Public Global Stellar Network ; September 2015")).toBe(
      "stellar:pubnet",
    );
  });

  it("throws for unknown passphrase", () => {
    expect(() => passphraseToX402Network("Unknown Network")).toThrow(/No x402 network mapping/);
  });
});

describe("createWalletermSigner", () => {
  it("returns signer with correct address", () => {
    const keypair = Keypair.random();
    const signer = createWalletermSigner(keypair, "stellar:testnet" as Network);
    expect(signer.address).toBe(keypair.publicKey());
    expect(typeof signer.signAuthEntry).toBe("function");
  });
});

describe("createX402HttpHandler", () => {
  it("creates handler with required methods", () => {
    const keypair = Keypair.random();
    const signer = createWalletermSigner(keypair, "stellar:testnet" as Network);
    const handler = createX402HttpHandler(signer, "stellar:testnet" as Network, "https://rpc.test");
    expect(typeof handler.getPaymentRequiredResponse).toBe("function");
    expect(typeof handler.createPaymentPayload).toBe("function");
    expect(typeof handler.encodePaymentSignatureHeader).toBe("function");
    expect(typeof handler.getPaymentSettleResponse).toBe("function");
  });
});

describe("executeX402Request", () => {
  it("passes through non-402 responses", async () => {
    const handler = makeMockHandler();
    const fetchFn = mockFetch(200, "ok response");

    const result = await executeX402Request(handler, {
      url: "https://example.com/resource",
      x402Network: "stellar:testnet" as Network,
      fetchFn,
    });

    expect(result.paid).toBe(false);
    expect(result.status).toBe(200);
    expect(decodeBody(result.body)).toBe("ok response");
    expect(result.paymentRequired).toBeUndefined();
    expect(handler.getPaymentRequiredResponse).not.toHaveBeenCalled();
  });

  it("returns payment requirements in dry-run mode", async () => {
    const handler = makeMockHandler();
    const fetchFn = mockFetch(402, JSON.stringify({ x402Version: 2 }), {
      "PAYMENT-REQUIRED": "base64stuff",
    });

    const result = await executeX402Request(handler, {
      url: "https://example.com/resource",
      x402Network: "stellar:testnet" as Network,
      dryRun: true,
      fetchFn,
    });

    expect(result.paid).toBe(false);
    expect(result.status).toBe(402);
    expect(result.paymentRequired).toBeDefined();
    expect(result.paymentPayload).toBeUndefined();
    expect(handler.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("throws when no matching payment option", async () => {
    const handler = makeMockHandler({
      getPaymentRequiredResponse: vi.fn(() =>
        makePaymentRequired("eip155:8453" as Network, "exact"),
      ),
    });
    const fetchFn = mockFetch(402, "{}");

    await expect(
      executeX402Request(handler, {
        url: "https://example.com/resource",
        x402Network: "stellar:testnet" as Network,
        fetchFn,
      }),
    ).rejects.toThrow(/No matching x402 payment option/);
  });

  it("completes full payment flow", async () => {
    const handler = makeMockHandler();
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ x402Version: 2 }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": "base64stuff" },
        });
      }
      return new Response("paid content", {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "base64settle" },
      });
    });

    const result = await executeX402Request(handler, {
      url: "https://example.com/resource",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"key":"value"}',
      x402Network: "stellar:testnet" as Network,
      fetchFn,
    });

    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(decodeBody(result.body)).toBe("paid content");
    expect(result.paymentRequired).toBeDefined();
    expect(result.paymentPayload).toBeDefined();
    expect(result.settlement).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(handler.createPaymentPayload).toHaveBeenCalled();
    expect(handler.encodePaymentSignatureHeader).toHaveBeenCalled();
  });

  it("handles missing settlement header gracefully", async () => {
    const handler = makeMockHandler({
      getPaymentSettleResponse: vi.fn(() => {
        throw new Error("No PAYMENT-RESPONSE header");
      }),
    });
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("{}", { status: 402 });
      }
      return new Response("content", { status: 200 });
    });

    const result = await executeX402Request(handler, {
      url: "https://example.com/resource",
      x402Network: "stellar:testnet" as Network,
      fetchFn,
    });

    expect(result.paid).toBe(true);
    expect(result.settlement).toBeUndefined();
  });

  it("handles non-JSON 402 response body", async () => {
    const handler = makeMockHandler();
    const fetchFn = mockFetch(402, "not json", {
      "PAYMENT-REQUIRED": "base64stuff",
    });

    const result = await executeX402Request(handler, {
      url: "https://example.com/resource",
      x402Network: "stellar:testnet" as Network,
      dryRun: true,
      fetchFn,
    });

    expect(result.paid).toBe(false);
    expect(result.paymentRequired).toBeDefined();
  });

  it("uses default GET method when not specified", async () => {
    const handler = makeMockHandler();
    const fetchFn = mockFetch(200, "ok");

    await executeX402Request(handler, {
      url: "https://example.com/resource",
      x402Network: "stellar:testnet" as Network,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/resource",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retries with merged headers when paying", async () => {
    const handler = makeMockHandler();
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("{}", { status: 402 });
      }
      return new Response("paid", {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "base64settle" },
      });
    });

    await executeX402Request(handler, {
      url: "https://example.com/resource",
      headers: { Authorization: "Bearer token" },
      x402Network: "stellar:testnet" as Network,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const retryHeaders = calls[1]![1]!.headers as Record<string, string>;
    expect(retryHeaders["Authorization"]).toBe("Bearer token");
    expect(retryHeaders["PAYMENT-SIGNATURE"]).toBe("base64encodedpayload");
  });
});
