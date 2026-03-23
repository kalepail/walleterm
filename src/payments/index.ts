import { Keypair } from "@stellar/stellar-sdk";
import type {
  MppIntent,
  NetworkConfig,
  PaymentProtocol,
  WalletermConfig,
  X402Scheme,
} from "../config.js";
import type { SecretResolver } from "../secrets.js";
import { isSshAgentRef } from "../secrets.js";
import { KeypairSigner, createSshAgentSigner } from "../signer.js";
import {
  createSshAgentX402Signer,
  createWalletermSigner,
  passphraseToX402Network,
} from "../x402.js";
import { executeMppPayment } from "./mpp.js";
import type { PaymentExecution, PaymentExecutionResult } from "./types.js";
import { executeX402Payment } from "./x402.js";

export interface PaymentRequestOptions {
  configPath?: string;
  url: string;
  method: string;
  rawHeaders: string[];
  body?: string;
  protocol?: string;
  x402Scheme?: string;
  intent?: string;
  secretRef?: string;
  sourceAccount?: string;
  x402ChannelDeposit?: string;
  x402ChannelStateFile?: string;
  x402ChannelCommitmentSecretRef?: string;
  dryRun: boolean;
  yes: boolean;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function resolvePayProtocol(config: WalletermConfig, explicit?: string): PaymentProtocol {
  const protocol =
    explicit ??
    config.payments?.default_protocol ??
    (config.payments?.mpp ? "mpp" : undefined) ??
    "x402";
  if (protocol !== "mpp" && protocol !== "x402") {
    throw new Error(`Unsupported payment protocol '${protocol}'. Expected x402 or mpp.`);
  }
  return protocol;
}

export function resolveMppIntent(config: WalletermConfig, explicit?: string): MppIntent {
  const intent = explicit ?? config.payments?.mpp?.default_intent ?? "charge";
  if (intent !== "charge" && intent !== "channel") {
    throw new Error(`Unsupported MPP intent '${intent}'. Expected charge or channel.`);
  }
  return intent;
}

export function resolveX402Scheme(config: WalletermConfig, explicit?: string): X402Scheme {
  const scheme = explicit ?? config.payments?.x402?.default_scheme ?? "exact";
  if (scheme !== "exact" && scheme !== "channel" && scheme !== "auto") {
    throw new Error(`Unsupported x402 scheme '${scheme}'. Expected exact, channel, or auto.`);
  }
  return scheme;
}

export function resolvePaymentSecretRef(
  config: WalletermConfig,
  protocol: PaymentProtocol,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  if (protocol === "mpp") {
    return config.payments?.mpp?.default_payer_secret_ref;
  }
  return config.payments?.x402?.default_payer_secret_ref;
}

export function resolveMaxPaymentAmount(
  config: WalletermConfig,
  protocol: PaymentProtocol,
): string | undefined {
  if (protocol === "mpp") {
    return config.payments?.mpp?.max_payment_amount;
  }
  return config.payments?.x402?.max_payment_amount;
}

function resolveCommitmentSecretRef(
  config: WalletermConfig,
  explicit?: string,
): string | undefined {
  return explicit ?? config.payments?.x402?.channel?.commitment_secret_ref;
}

export function buildPayHeaders(rawHeaders: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of rawHeaders) {
    const idx = header.indexOf(":");
    if (idx < 0) {
      throw new Error(`Invalid header format: ${header}. Expected "Name: Value".`);
    }
    headers[header.slice(0, idx).trim()] = header.slice(idx + 1).trim();
  }
  return headers;
}

function resolvePaymentSecret(
  resolvedSecret: string,
  secretRef: string,
): { keypair: Keypair; secretRef: string } {
  try {
    return {
      keypair: Keypair.fromSecret(resolvedSecret),
      secretRef,
    };
  } catch {
    throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
  }
}

export async function executePaymentRequest(
  config: WalletermConfig,
  networkName: string,
  network: NetworkConfig,
  resolver: SecretResolver,
  opts: PaymentRequestOptions & { mppChannelStatePath?: string },
): Promise<PaymentExecution> {
  const protocol = resolvePayProtocol(config, opts.protocol);
  const intent = protocol === "mpp" ? resolveMppIntent(config, opts.intent) : undefined;
  const x402Scheme = protocol === "x402" ? resolveX402Scheme(config, opts.x402Scheme) : undefined;
  const secretRef = resolvePaymentSecretRef(config, protocol, opts.secretRef);
  if (!secretRef) {
    throw new Error(
      "No payer specified. Pass --secret-ref or set a protocol default payer secret ref in config.",
    );
  }

  let payerPublicKey: string;
  let mppKeypair: Keypair | undefined;

  const x402Payment = protocol === "x402";
  const x402Network = x402Payment ? passphraseToX402Network(network.network_passphrase) : null;

  let payerSigner: import("../signer.js").Signer | undefined;
  let exactSigner: import("../x402.js").ClientStellarSigner | undefined;

  if (isSshAgentRef(secretRef)) {
    const agentSigner = await createSshAgentSigner(secretRef);
    payerPublicKey = agentSigner.publicKey();
    payerSigner = agentSigner;
    if (x402Network) exactSigner = createSshAgentX402Signer(agentSigner);
  } else {
    const secret = await resolver.resolve(secretRef);
    const { keypair } = resolvePaymentSecret(secret, secretRef);
    payerPublicKey = keypair.publicKey();
    payerSigner = new KeypairSigner(keypair);
    if (x402Network) exactSigner = createWalletermSigner(keypair, x402Network);
    mppKeypair = keypair;
  }

  let commitmentKeypair: import("../signer.js").Signer = payerSigner!;
  let commitmentSecretRef: string | undefined;
  if (x402Payment) {
    commitmentSecretRef = resolveCommitmentSecretRef(config, opts.x402ChannelCommitmentSecretRef);
    if (commitmentSecretRef) {
      if (isSshAgentRef(commitmentSecretRef)) {
        commitmentKeypair = await createSshAgentSigner(commitmentSecretRef);
      } else {
        const commitmentSecret = await resolver.resolve(commitmentSecretRef);
        try {
          commitmentKeypair = new KeypairSigner(Keypair.fromSecret(commitmentSecret));
        } catch {
          throw new Error(
            "x402 channel commitment secret ref must resolve to a valid Stellar secret seed (S...)",
          );
        }
      }
    }
  }
  const headers = buildPayHeaders(opts.rawHeaders);
  const requestHeaders = Object.keys(headers).length > 0 ? headers : undefined;
  const maxPaymentAmount = resolveMaxPaymentAmount(config, protocol);
  const fetchFn = opts.fetchFn ?? fetch;

  const result =
    protocol === "x402"
      ? await executeX402Payment({
          url: opts.url,
          method: opts.method,
          headers: requestHeaders,
          body: opts.body,
          network,
          payerSigner: payerSigner!,
          exactSigner: exactSigner!,
          payerSecretRef: secretRef,
          commitmentKeypair,
          commitmentSecretRef,
          networkName,
          configPath: opts.configPath ?? "walleterm.toml",
          schemeSelection: x402Scheme!,
          channelConfig: config.payments?.x402?.channel,
          statePathOverride: opts.x402ChannelStateFile,
          depositOverride: opts.x402ChannelDeposit,
          dryRun: opts.dryRun,
          maxPaymentAmount,
          yes: opts.yes,
          fetchFn,
        })
      : await executeMppPayment({
          url: opts.url,
          method: opts.method,
          headers: requestHeaders,
          body: opts.body,
          networkName,
          network,
          keypair: mppKeypair!,
          secretRef,
          intent: intent!,
          sourceAccount: opts.sourceAccount ?? config.payments?.mpp?.channel?.source_account,
          dryRun: opts.dryRun,
          maxPaymentAmount,
          yes: opts.yes,
          fetchFn,
          mppChannelStatePath: opts.mppChannelStatePath,
        });

  return {
    protocol,
    intent,
    payer: payerPublicKey,
    secretRef,
    result,
  };
}

export function buildPaymentJsonResult(
  protocol: PaymentProtocol,
  payer: string,
  result: PaymentExecutionResult,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    protocol,
    scheme: result.scheme ?? null,
    paid: result.paid,
    status: result.status,
    payer,
    response_headers: result.responseHeaders,
    challenge: result.challenge,
    payment_attempt: result.paymentAttempt,
    settlement: result.settlement,
    protocol_error: result.settlementError ?? null,
    settlement_error: result.settlementError ?? null,
    channel: result.channel ?? null,
    body: Buffer.from(result.body).toString("base64"),
  };

  if (protocol === "x402") {
    payload.payment_required = result.challenge;
    payload.payment_payload = result.paymentAttempt;
  }

  return payload;
}
