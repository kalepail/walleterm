import { createHash } from "node:crypto";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import type {
  DecodedHeader,
  DemoChannelOffer,
  NormalizedChannelOffer,
  StateChannelOffer,
} from "./types.js";

function decodeJsonHeader<T>(raw: string | null | undefined): DecodedHeader<T> {
  if (!raw) return {};
  try {
    return { value: JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as T };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parsePaymentRequired(response: Response, bodyJson: unknown): PaymentRequired {
  const decoded = decodeJsonHeader<PaymentRequired>(response.headers.get("PAYMENT-REQUIRED"));
  if (decoded.value?.accepts) {
    return decoded.value;
  }

  if (
    bodyJson &&
    typeof bodyJson === "object" &&
    Array.isArray((bodyJson as PaymentRequired).accepts)
  ) {
    return bodyJson as PaymentRequired;
  }

  if (decoded.error) {
    throw new Error(`Failed to decode PAYMENT-REQUIRED header: ${decoded.error}`);
  }

  throw new Error("Unable to parse x402 payment requirements from 402 response");
}

export function parseSettlement(
  response: Response,
  bodyJson: unknown,
): {
  settlement?: SettleResponse | Record<string, unknown>;
  settlementError?: string;
} {
  const decoded = decodeJsonHeader<SettleResponse | Record<string, unknown>>(
    response.headers.get("PAYMENT-RESPONSE"),
  );
  if (decoded.value) {
    return { settlement: decoded.value };
  }

  if (
    bodyJson &&
    typeof bodyJson === "object" &&
    ("success" in (bodyJson as Record<string, unknown>) ||
      "channelId" in (bodyJson as Record<string, unknown>) ||
      "currentCumulative" in (bodyJson as Record<string, unknown>))
  ) {
    return { settlement: bodyJson as Record<string, unknown> };
  }

  return { settlementError: decoded.error };
}

export function selectChannelAccept(
  paymentRequired: PaymentRequired,
  network: Network,
): PaymentRequired["accepts"][number] | undefined {
  return paymentRequired.accepts.find((req) => req.network === network && req.scheme === "channel");
}

export function normalizeChannelOffer(
  accepted: PaymentRequired["accepts"][number],
): NormalizedChannelOffer {
  const extra = (accepted.extra ?? {}) as Record<string, unknown>;
  const channelContract =
    typeof extra.channelContract === "string"
      ? extra.channelContract
      : typeof (accepted as Record<string, unknown>).channelContract === "string"
        ? String((accepted as Record<string, unknown>).channelContract)
        : undefined;

  const topLevel = accepted as Record<string, unknown>;
  const price =
    typeof topLevel.price === "string"
      ? topLevel.price
      : typeof accepted.amount === "string" && accepted.amount
        ? accepted.amount
        : undefined;
  if (!price) {
    throw new Error("Experimental x402 channel offer is missing amount/price");
  }

  const serverPublicKey =
    typeof extra.serverPublicKey === "string"
      ? extra.serverPublicKey
      : typeof topLevel.serverPublicKey === "string"
        ? topLevel.serverPublicKey
        : undefined;

  if (channelContract && serverPublicKey) {
    const stateOffer: StateChannelOffer = {
      mode: "state",
      accepted,
      price,
      asset: accepted.asset,
      payTo: accepted.payTo,
      channelContract,
      serverPublicKey,
      suggestedDeposit:
        typeof extra.suggestedDeposit === "string"
          ? extra.suggestedDeposit
          : typeof topLevel.suggestedDeposit === "string"
            ? topLevel.suggestedDeposit
            : undefined,
    };
    return stateOffer;
  }

  const demoOffer: DemoChannelOffer = {
    mode: "demo",
    accepted,
    price,
    asset: accepted.asset,
    payTo: accepted.payTo || serverPublicKey || "demo-channel",
    serverPublicKey,
    suggestedDeposit:
      typeof extra.suggestedDeposit === "string"
        ? extra.suggestedDeposit
        : typeof topLevel.suggestedDeposit === "string"
          ? topLevel.suggestedDeposit
          : undefined,
  };
  return demoOffer;
}

export function makeChannelContextKey(
  url: string,
  networkName: string,
  offer: NormalizedChannelOffer,
  payerPublicKey: string,
): string {
  const parsed = new URL(url);
  const raw = [
    networkName,
    offer.mode,
    parsed.origin,
    parsed.pathname,
    offer.asset,
    offer.payTo,
    payerPublicKey,
  ].join("\n");
  return createHash("sha256").update(raw).digest("hex");
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function parseResponseBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

export function paymentHeaders(
  payload: PaymentPayload,
  headers?: Record<string, string>,
): Record<string, string> {
  return {
    ...headers,
    "PAYMENT-SIGNATURE": encodePaymentPayload(payload),
  };
}
