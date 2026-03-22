import { Keypair } from "@stellar/stellar-sdk";
import type { MppIntent, NetworkConfig } from "../config.js";
import { rememberMppVoucher } from "../mpp-channel.js";
import {
  createMppClientMethod,
  executeMppRequest,
  passphraseToMppNetwork,
  type MppChannelAction,
  type MppChargeMode,
} from "../mpp.js";
import type { PaymentExecutionResult } from "./types.js";

export interface ExecuteMppPaymentOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  networkName: string;
  network: NetworkConfig;
  keypair: Keypair;
  secretRef: string;
  intent: MppIntent;
  sourceAccount?: string;
  dryRun: boolean;
  maxPaymentAmount?: string;
  yes: boolean;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  mppChannelStatePath?: string;
}

export async function executeMppPayment(
  opts: ExecuteMppPaymentOptions,
): Promise<PaymentExecutionResult> {
  const mppNetwork = passphraseToMppNetwork(opts.network.network_passphrase);
  const clientMethod = createMppClientMethod({
    intent: opts.intent,
    secret: opts.keypair.secret(),
    rpcUrl: opts.network.rpc_url,
    sourceAccount: opts.sourceAccount,
    chargeMode: "pull" as MppChargeMode,
  });
  const context =
    opts.intent === "channel"
      ? ({
          action: "voucher" as MppChannelAction,
        } satisfies Record<string, unknown>)
      : ({
          mode: "pull" as MppChargeMode,
        } satisfies Record<string, unknown>);

  const result = await executeMppRequest([clientMethod], {
    url: opts.url,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    intent: opts.intent,
    network: mppNetwork,
    dryRun: opts.dryRun,
    maxPaymentAmount: opts.maxPaymentAmount,
    yes: opts.yes,
    context,
    fetchFn: opts.fetchFn,
  });

  if (opts.intent === "channel" && opts.mppChannelStatePath) {
    const challengeRequest = result.challenge?.request as { channel?: string } | undefined;
    const payload = result.paymentAttempt?.payload as
      | { amount?: string; signature?: string }
      | undefined;
    if (challengeRequest?.channel && payload?.amount && payload?.signature) {
      rememberMppVoucher(opts.mppChannelStatePath, {
        channelId: challengeRequest.channel,
        networkName: opts.networkName,
        networkPassphrase: opts.network.network_passphrase,
        sourceAccount: opts.sourceAccount ?? opts.keypair.publicKey(),
        secretRef: opts.secretRef,
        cumulativeAmount: payload.amount,
        signatureHex: payload.signature,
      });
    }
  }

  return {
    paid: result.paid,
    status: result.status,
    body: result.body,
    responseHeaders: result.responseHeaders,
    challenge: result.challenge,
    paymentAttempt: result.paymentAttempt,
    settlement: result.settlement,
    settlementError: result.settlementError,
  };
}
