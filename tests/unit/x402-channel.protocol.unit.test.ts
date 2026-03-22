import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  makeChannelContextKey,
  normalizeChannelOffer,
  parsePaymentRequired,
  parseSettlement,
  paymentHeaders,
} from "../../src/x402-channel/protocol.js";

describe("x402-channel protocol helpers", () => {
  it("parses payment requirements from the header or response body", () => {
    const paymentRequired = {
      x402Version: 1,
      resource: { url: "https://example.com/file", mimeType: "text/plain" },
      accepts: [
        {
          scheme: "channel",
          network: "stellar:testnet",
          asset: StrKey.encodeContract(Buffer.alloc(32, 1)),
          amount: "10",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    } as const;

    const headerResponse = new Response("payment required", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64"),
      },
    });
    expect(parsePaymentRequired(headerResponse, undefined)).toEqual(paymentRequired);

    const bodyResponse = new Response("payment required", { status: 402 });
    expect(parsePaymentRequired(bodyResponse, paymentRequired)).toEqual(paymentRequired);
  });

  it("surfaces malformed or missing PAYMENT-REQUIRED data", () => {
    const badHeaderResponse = new Response("payment required", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": "!!!!" },
    });
    expect(() => parsePaymentRequired(badHeaderResponse, undefined)).toThrow(
      /failed to decode payment-required/i,
    );

    expect(() =>
      parsePaymentRequired(new Response("payment required", { status: 402 }), undefined),
    ).toThrow(/unable to parse x402 payment requirements/i);
  });

  it("parses settlement information from the header, body, or decode failure", () => {
    const settlement = {
      success: true,
      channelId: "ab".repeat(32),
      currentCumulative: "10",
    };
    const headerResponse = new Response("ok", {
      status: 200,
      headers: {
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
      },
    });
    expect(parseSettlement(headerResponse, undefined)).toEqual({ settlement });

    const bodyResponse = new Response("ok", { status: 200 });
    expect(parseSettlement(bodyResponse, settlement)).toEqual({ settlement });

    const badHeaderResponse = new Response("ok", {
      status: 200,
      headers: { "PAYMENT-RESPONSE": "!!!!" },
    });
    expect(parseSettlement(badHeaderResponse, undefined).settlementError).toBeTruthy();
  });

  it("normalizes state and demo channel offers and rejects missing prices", () => {
    const baseAccepted = {
      scheme: "channel",
      network: "stellar:testnet",
      asset: StrKey.encodeContract(Buffer.alloc(32, 2)),
      amount: "25",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: {
        channelContract: StrKey.encodeContract(Buffer.alloc(32, 3)),
        serverPublicKey: Keypair.random().publicKey(),
        suggestedDeposit: "2500",
      },
    } as const;

    const stateOffer = normalizeChannelOffer(baseAccepted);
    expect(stateOffer.mode).toBe("state");
    expect(stateOffer.suggestedDeposit).toBe("2500");

    const demoOffer = normalizeChannelOffer({
      ...baseAccepted,
      extra: { suggestedDeposit: "2500" },
      serverPublicKey: Keypair.random().publicKey(),
    } as typeof baseAccepted & { serverPublicKey: string });
    expect(demoOffer.mode).toBe("demo");

    expect(() =>
      normalizeChannelOffer({
        ...baseAccepted,
        amount: "",
        price: undefined,
      } as unknown as typeof baseAccepted),
    ).toThrow(/missing amount\/price/i);
  });

  it("builds stable channel keys and encoded payment headers", () => {
    const offer = normalizeChannelOffer({
      scheme: "channel",
      network: "stellar:testnet",
      asset: StrKey.encodeContract(Buffer.alloc(32, 4)),
      amount: "10",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: { suggestedDeposit: "1000" },
    } as const);
    const payer = Keypair.random().publicKey();
    const keyA = makeChannelContextKey("https://example.com/a", "testnet", offer, payer);
    const keyB = makeChannelContextKey("https://example.com/a", "testnet", offer, payer);
    const keyC = makeChannelContextKey("https://example.com/b", "testnet", offer, payer);
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);

    const headers = paymentHeaders({
      x402Version: 1,
      resource: { url: "https://example.com/a", mimeType: "text/plain" },
      accepted: {
        scheme: "channel",
        network: "stellar:testnet",
        asset: StrKey.encodeContract(Buffer.alloc(32, 5)),
        amount: "10",
        payTo: Keypair.random().publicKey(),
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { action: "pay", channelId: "ab".repeat(32) },
    });
    expect(headers["PAYMENT-SIGNATURE"]).toBeTypeOf("string");
  });
});
