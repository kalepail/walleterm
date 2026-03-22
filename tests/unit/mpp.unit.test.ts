import { Challenge, Credential, Receipt } from "mppx";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createMppClientMethod,
  executeMppRequest,
  passphraseToMppNetwork,
  type MppChallenge,
  type MppClientMethod,
} from "../../src/mpp.js";

function makeChallenge(intent: "charge" | "channel" = "charge"): MppChallenge {
  return {
    id: "challenge-1",
    realm: "api.example.com",
    method: "stellar",
    intent,
    request: {
      amount: "100",
      recipient: "GRECIPIENT",
      currency: "CUSDCTOKEN",
      channel: "CCHANNEL",
      methodDetails: {},
    },
  };
}

function mockFetch(status: number, body: string, headers?: Record<string, string>) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

function makeMethod(
  intent: "charge" | "channel" = "charge",
  createCredential?: ReturnType<typeof vi.fn>,
): MppClientMethod {
  return {
    name: "stellar",
    intent,
    createCredential: (createCredential ??
      vi.fn(async ({ challenge }) =>
        Credential.serialize({
          challenge,
          payload: { type: "transaction", xdr: "AAAA" },
        }),
      )) as unknown as MppClientMethod["createCredential"],
  };
}

describe("passphraseToMppNetwork", () => {
  it("maps testnet passphrase", () => {
    expect(passphraseToMppNetwork("Test SDF Network ; September 2015")).toBe("testnet");
  });

  it("maps pubnet passphrase", () => {
    expect(passphraseToMppNetwork("Public Global Stellar Network ; September 2015")).toBe("public");
  });

  it("throws for unknown passphrases", () => {
    expect(() => passphraseToMppNetwork("Custom Network")).toThrow(/No MPP network mapping/i);
  });
});

describe("createMppClientMethod", () => {
  it("creates charge and channel clients from a valid stellar secret", () => {
    const secret = Keypair.random().secret();

    const charge = createMppClientMethod({
      intent: "charge",
      secret,
      rpcUrl: "https://rpc.example",
      chargeMode: "push",
    });
    expect(charge).toEqual(
      expect.objectContaining({
        name: "stellar",
        intent: "charge",
        createCredential: expect.any(Function),
      }),
    );

    const channel = createMppClientMethod({
      intent: "channel",
      secret,
      rpcUrl: "https://rpc.example",
      sourceAccount: Keypair.random().publicKey(),
    });
    expect(channel).toEqual(
      expect.objectContaining({
        name: "stellar",
        intent: "channel",
        createCredential: expect.any(Function),
      }),
    );
  });
});

describe("executeMppRequest", () => {
  it("passes through non-402 responses", async () => {
    const fetchFn = mockFetch(200, "ok");

    const result = await executeMppRequest([makeMethod()], {
      url: "https://example.com/resource",
      intent: "charge",
      network: "testnet",
      fetchFn,
    });

    expect(result.paid).toBe(false);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("ok");
  });

  it("returns the parsed challenge in dry-run mode", async () => {
    const challenge = makeChallenge();
    const fetchFn = mockFetch(402, "payment required", {
      "WWW-Authenticate": Challenge.serialize(challenge),
    });

    const result = await executeMppRequest([makeMethod()], {
      url: "https://example.com/resource",
      intent: "charge",
      network: "testnet",
      dryRun: true,
      fetchFn,
    });

    expect(result.paid).toBe(false);
    expect(result.challenge?.intent).toBe("charge");
    expect(result.challenge?.request.methodDetails?.network).toBe("testnet");
  });

  it("preserves an existing methodDetails.network value", async () => {
    const challenge = makeChallenge();
    challenge.request.methodDetails = { network: "public" };
    const fetchFn = mockFetch(402, "payment required", {
      "WWW-Authenticate": Challenge.serialize(challenge),
    });

    const result = await executeMppRequest([makeMethod()], {
      url: "https://example.com/resource",
      intent: "charge",
      network: "testnet",
      dryRun: true,
      fetchFn,
    });

    expect(result.challenge?.request.methodDetails?.network).toBe("public");
  });

  it("creates a credential, retries, and parses the receipt", async () => {
    const challenge = makeChallenge();
    const receipt = Receipt.serialize({
      method: "stellar",
      reference: "txhash",
      status: "success",
      timestamp: "2026-03-20T00:00:00.000Z",
    });
    const createCredential = vi.fn(async ({ challenge: currentChallenge }) =>
      Credential.serialize({
        challenge: currentChallenge,
        payload: { type: "transaction", xdr: "AAAA" },
      }),
    );

    let callCount = 0;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("payment required", {
          status: 402,
          headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
        });
      }

      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: expect.stringMatching(/^Payment /),
        }),
      );
      return new Response("paid", {
        status: 200,
        headers: { "Payment-Receipt": receipt },
      });
    });

    const result = await executeMppRequest([makeMethod("charge", createCredential)], {
      url: "https://example.com/resource",
      intent: "charge",
      network: "testnet",
      fetchFn,
    });

    expect(result.paid).toBe(true);
    expect(result.paymentAttempt?.payload).toEqual({ type: "transaction", xdr: "AAAA" });
    expect(result.settlement?.reference).toBe("txhash");
    expect(createCredential).toHaveBeenCalledTimes(1);
  });

  it("surfaces settlement parsing errors without failing a successful paid response", async () => {
    const challenge = makeChallenge();

    let callCount = 0;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("payment required", {
          status: 402,
          headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
        });
      }

      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: expect.stringMatching(/^Payment /),
        }),
      );
      return new Response("paid", {
        status: 200,
        headers: { "Payment-Receipt": "definitely-not-a-valid-receipt" },
      });
    });

    const result = await executeMppRequest([makeMethod()], {
      url: "https://example.com/resource",
      intent: "charge",
      network: "testnet",
      fetchFn,
    });

    expect(result.paid).toBe(true);
    expect(result.settlement).toBeUndefined();
    expect(result.settlementError).toMatch(/invalid|not valid json/i);
  });

  it("rejects conflicting Authorization headers", async () => {
    const challenge = makeChallenge();
    const fetchFn = mockFetch(402, "payment required", {
      "WWW-Authenticate": Challenge.serialize(challenge),
    });

    await expect(
      executeMppRequest([makeMethod()], {
        url: "https://example.com/resource",
        intent: "charge",
        network: "testnet",
        headers: { Authorization: "Bearer token" },
        fetchFn,
      }),
    ).rejects.toThrow(/cannot be combined with an existing Authorization header/i);
  });

  it("enforces max payment amount unless --yes is passed", async () => {
    const challenge = makeChallenge();
    const fetchFn = mockFetch(402, "payment required", {
      "WWW-Authenticate": Challenge.serialize(challenge),
    });

    await expect(
      executeMppRequest([makeMethod()], {
        url: "https://example.com/resource",
        intent: "charge",
        network: "testnet",
        maxPaymentAmount: "50",
        fetchFn,
      }),
    ).rejects.toThrow(/exceeds configured max_payment_amount/i);
  });

  it("errors when no advertised challenge matches the requested intent", async () => {
    const fetchFn = mockFetch(402, "payment required", {
      "WWW-Authenticate": Challenge.serialize(makeChallenge("channel")),
    });

    await expect(
      executeMppRequest([makeMethod("charge")], {
        url: "https://example.com/resource",
        intent: "charge",
        network: "testnet",
        fetchFn,
      }),
    ).rejects.toThrow(/No matching MPP payment option/i);
  });
});
