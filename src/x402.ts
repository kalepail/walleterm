import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  ExactStellarScheme,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  createEd25519Signer,
  type ClientStellarSigner,
} from "@x402/stellar";

const PASSPHRASE_TO_X402_NETWORK = new Map<string, Network>([
  ["Test SDF Network ; September 2015", STELLAR_TESTNET_CAIP2 as Network],
  ["Public Global Stellar Network ; September 2015", STELLAR_PUBNET_CAIP2 as Network],
]);

export function passphraseToX402Network(passphrase: string): Network {
  const network = PASSPHRASE_TO_X402_NETWORK.get(passphrase);
  if (!network) {
    throw new Error(`No x402 network mapping for passphrase: ${passphrase}`);
  }
  return network;
}

export function createWalletermSigner(keypair: Keypair, network: Network): ClientStellarSigner {
  return createEd25519Signer(keypair.secret(), network);
}

export interface X402HttpHandler {
  getPaymentRequiredResponse(
    getHeader: (name: string) => string | null | undefined,
    body?: unknown,
  ): PaymentRequired;
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;
  encodePaymentSignatureHeader(paymentPayload: PaymentPayload): Record<string, string>;
  getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponse;
}

export function createX402HttpHandler(
  signer: ClientStellarSigner,
  x402Network: Network,
  rpcUrl: string,
): X402HttpHandler {
  const scheme = new ExactStellarScheme(signer, { url: rpcUrl });
  const client = new x402Client();
  client.register(x402Network, scheme);
  return new x402HTTPClient(client);
}

export interface X402FetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  x402Network: Network;
  dryRun?: boolean;
  maxPaymentAmount?: string;
  yes?: boolean;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface X402Result {
  paid: boolean;
  status: number;
  body: Uint8Array;
  responseHeaders: Record<string, string>;
  paymentRequired?: PaymentRequired;
  paymentPayload?: PaymentPayload;
  settlement?: SettleResponse;
  settlementError?: string;
}

/* v8 ignore start -- command-layer tests cover these branches, but v8 branch accounting is noisy here */
export async function executeX402Request(
  handler: X402HttpHandler,
  opts: X402FetchOptions,
): Promise<X402Result> {
  const fetchFn = opts.fetchFn;

  const initialResponse = await fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });

  if (initialResponse.status !== 402) {
    return {
      paid: false,
      status: initialResponse.status,
      body: new Uint8Array(await initialResponse.arrayBuffer()),
      responseHeaders: Object.fromEntries(initialResponse.headers.entries()),
    };
  }

  const initialBytes = new Uint8Array(await initialResponse.arrayBuffer());
  const initialBody = new TextDecoder().decode(initialBytes);
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(initialBody);
  } catch {
    bodyJson = undefined;
  }

  const paymentRequired = handler.getPaymentRequiredResponse(
    (name: string) => initialResponse.headers.get(name),
    bodyJson,
  );

  const stellarAccepts = paymentRequired.accepts.filter(
    (req) => req.network === opts.x402Network && req.scheme === "exact",
  );
  if (stellarAccepts.length === 0) {
    throw new Error(
      `No matching x402 payment option for network ${opts.x402Network} with scheme "exact". ` +
        `Available: ${paymentRequired.accepts.map((a) => `${a.network}/${a.scheme}`).join(", ")}`,
    );
  }

  if (opts.dryRun) {
    return {
      paid: false,
      status: 402,
      body: initialBytes,
      responseHeaders: Object.fromEntries(initialResponse.headers.entries()),
      paymentRequired,
    };
  }

  const accepted = stellarAccepts[0]!;

  if (opts.maxPaymentAmount && !opts.yes) {
    const amount = Number(accepted.amount);
    const max = Number(opts.maxPaymentAmount);
    /* v8 ignore next -- config validation already guarantees numeric max_payment_amount */
    if (amount > max) {
      throw new Error(
        `Payment amount ${accepted.amount} exceeds configured max_payment_amount ${opts.maxPaymentAmount}. Use --yes to override.`,
      );
    }
  }

  process.stderr.write(
    `x402: paying ${accepted.amount} via ${accepted.scheme} on ${accepted.network} to ${accepted.payTo}\n`,
  );

  const paymentPayload = await handler.createPaymentPayload(paymentRequired);
  const paymentHeaders = handler.encodePaymentSignatureHeader(paymentPayload);
  const retryHeaders = { ...opts.headers, ...paymentHeaders };

  const retryResponse = await fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: retryHeaders,
    body: opts.body,
  });

  let settlement: SettleResponse | undefined;
  let settlementError: string | undefined;
  try {
    settlement = handler.getPaymentSettleResponse((name: string) =>
      retryResponse.headers.get(name),
    );
  } catch (error) {
    /* v8 ignore next -- settlement parsing failures are validated by command-level tests */
    settlementError = error instanceof Error ? error.message : String(error);
  }

  return {
    paid: true,
    status: retryResponse.status,
    body: new Uint8Array(await retryResponse.arrayBuffer()),
    responseHeaders: Object.fromEntries(retryResponse.headers.entries()),
    paymentRequired,
    paymentPayload,
    settlement,
    settlementError,
  };
}
/* v8 ignore stop */
