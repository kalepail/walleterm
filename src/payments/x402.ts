import type { NetworkConfig, X402ChannelConfig, X402Scheme } from "../config.js";
import type { Signer } from "../signer.js";
import {
  type ClientStellarSigner,
  createX402HttpHandler,
  executeX402Request,
  passphraseToX402Network,
} from "../x402.js";
import { executeX402ChannelRequest } from "../x402-channel.js";
import type { PaymentExecutionResult } from "./types.js";

export interface ExecuteX402PaymentOptions {
  configPath: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  networkName: string;
  network: NetworkConfig;
  payerSigner: Signer;
  exactSigner: ClientStellarSigner;
  payerSecretRef?: string;
  commitmentKeypair: Signer;
  commitmentSecretRef?: string;
  schemeSelection: X402Scheme;
  channelConfig?: X402ChannelConfig;
  statePathOverride?: string;
  depositOverride?: string;
  dryRun: boolean;
  maxPaymentAmount?: string;
  yes: boolean;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function executeX402Payment(
  opts: ExecuteX402PaymentOptions,
): Promise<PaymentExecutionResult> {
  const x402Network = passphraseToX402Network(opts.network.network_passphrase);
  if (opts.schemeSelection === "channel" || opts.schemeSelection === "auto") {
    const channelResult = await executeX402ChannelRequest({
      url: opts.url,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      x402Network,
      networkName: opts.networkName,
      networkPassphrase: opts.network.network_passphrase,
      rpcUrl: opts.network.rpc_url,
      configPath: opts.configPath,
      schemeSelection: opts.schemeSelection,
      payerKeypair: opts.payerSigner,
      payerSecretRef: opts.payerSecretRef,
      commitmentKeypair: opts.commitmentKeypair,
      commitmentSecretRef: opts.commitmentSecretRef,
      channelConfig: opts.channelConfig,
      depositOverride: opts.depositOverride,
      statePathOverride: opts.statePathOverride,
      dryRun: opts.dryRun,
      maxPaymentAmount: opts.maxPaymentAmount,
      yes: opts.yes,
      fetchFn: opts.fetchFn,
    });
    if (channelResult.kind !== "fallback-exact") {
      return {
        scheme: channelResult.scheme,
        paid: channelResult.paid,
        status: channelResult.status,
        body: channelResult.body,
        responseHeaders: channelResult.responseHeaders,
        challenge: channelResult.paymentRequired,
        paymentAttempt: channelResult.paymentPayload,
        settlement: channelResult.settlement,
        settlementError: channelResult.settlementError,
        channel: channelResult.channel,
      };
    }
  }

  const signer = opts.exactSigner;
  const handler = createX402HttpHandler(signer, x402Network, opts.network.rpc_url);
  const result = await executeX402Request(handler, {
    url: opts.url,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    x402Network,
    dryRun: opts.dryRun,
    maxPaymentAmount: opts.maxPaymentAmount,
    yes: opts.yes,
    fetchFn: opts.fetchFn,
  });

  return {
    scheme: "exact",
    paid: result.paid,
    status: result.status,
    body: result.body,
    responseHeaders: result.responseHeaders,
    challenge: result.paymentRequired,
    paymentAttempt: result.paymentPayload,
    settlement: result.settlement,
    settlementError: result.settlementError,
  };
}
