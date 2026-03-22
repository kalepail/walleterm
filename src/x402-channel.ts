import { createHash, randomBytes } from "node:crypto";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  makeChannelContextKey,
  normalizeChannelOffer,
  parsePaymentRequired,
  parseResponseBody,
  parseSettlement,
  paymentHeaders,
  selectChannelAccept,
} from "./x402-channel/protocol.js";
import {
  resolveStoredChannelByKey,
  resolveX402ChannelStatePath,
  upsertStoredChannel,
} from "./x402-channel/storage.js";
import type {
  DemoChannelOffer,
  StateChannelOffer,
  StoredX402Channel,
  X402ChannelExecuteOptions,
  X402ChannelFallbackResult,
  X402ChannelResult,
} from "./x402-channel/types.js";

export { resolveX402ChannelStatePath } from "./x402-channel/storage.js";
export type {
  StoredX402Channel,
  X402ChannelExecuteOptions,
  X402ChannelFallbackResult,
  X402ChannelResult,
} from "./x402-channel/types.js";

function parseNonNegativeBigInt(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return BigInt(value);
}

function amountExceedsCap(amount: string, max: string | undefined): boolean {
  if (!max) return false;
  const amountNum = Number(amount);
  const maxNum = Number(max);
  if (!Number.isFinite(amountNum) || !Number.isFinite(maxNum)) {
    return false;
  }
  return amountNum > maxNum;
}

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
  const mask64 = (1n << 64n) - 1n;
  const hi = (value >> 64n) & mask64;
  const lo = value & mask64;
  buf.writeBigUInt64BE(hi, offset);
  buf.writeBigUInt64BE(lo, offset + 8);
}

function signStateHex(
  keypair: Keypair,
  channelId: string,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): string {
  const channelIdBytes = Buffer.from(channelId, "hex");
  const buf = Buffer.alloc(72);
  channelIdBytes.copy(buf, 0);
  buf.writeBigUInt64BE(iteration, 32);
  writeBigInt128BE(buf, agentBalance, 40);
  writeBigInt128BE(buf, serverBalance, 56);
  return Buffer.from(keypair.sign(buf)).toString("hex");
}

function signCloseIntentHex(keypair: Keypair, channelId: string): string {
  return Buffer.from(
    keypair.sign(Buffer.concat([Buffer.from(channelId, "hex"), Buffer.from("close", "utf8")])),
  ).toString("hex");
}

function deriveStateChannelId(commitmentKeypair: Keypair, nonce: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(commitmentKeypair.rawPublicKey()))
    .update(nonce)
    .digest("hex");
}

function deriveDemoChannelId(commitmentKeypair: Keypair): string {
  return createHash("sha256")
    .update(Buffer.from(commitmentKeypair.rawPublicKey()))
    .update(randomBytes(32))
    .digest("hex");
}

async function sendInitialRequest(
  opts: X402ChannelExecuteOptions,
): Promise<{ response: Response; bytes: Uint8Array; bodyJson: unknown }> {
  const response = await opts.fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, bodyJson: parseResponseBody(bytes) };
}

async function buildStateOpenTransaction(
  rpcUrl: string,
  networkPassphrase: string,
  payerKeypair: Keypair,
  offer: StateChannelOffer,
  commitmentKeypair: Keypair,
  deposit: bigint,
  nonce: Buffer,
): Promise<string> {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(payerKeypair.publicKey());
  const contract = new Contract(offer.channelContract);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "open_channel",
        new Address(payerKeypair.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(commitmentKeypair.rawPublicKey())),
        new Address(offer.payTo).toScVal(),
        xdr.ScVal.scvBytes(
          Buffer.from(Keypair.fromPublicKey(offer.serverPublicKey).rawPublicKey()),
        ),
        new Address(offer.asset).toScVal(),
        nativeToScVal(deposit, { type: "i128" }),
        xdr.ScVal.scvBytes(Buffer.from(nonce)),
      ),
    )
    .setTimeout(Math.max(offer.accepted.maxTimeoutSeconds, 30))
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(payerKeypair);
  return prepared.toXDR();
}

function extractSettlementField(
  settlement: SettleResponse | Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value =
    settlement && typeof settlement === "object"
      ? (settlement as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : undefined;
}

async function closeStateChannel(
  opts: X402ChannelExecuteOptions,
  paymentRequired: PaymentRequired,
  offer: StateChannelOffer,
  stored: StoredX402Channel,
  statePath: string,
): Promise<void> {
  const closePayload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: offer.accepted,
    payload: {
      action: "close",
      channelId: stored.channel_id,
      signature: signCloseIntentHex(opts.commitmentKeypair, stored.channel_id),
    },
  };
  const response = await opts.fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: paymentHeaders(closePayload, opts.headers),
    body: opts.body,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const bodyJson = parseResponseBody(body);
  const { settlement, settlementError } = parseSettlement(response, bodyJson);
  if (!response.ok) {
    throw new Error(
      extractSettlementField(settlement, "error") ??
        (bodyJson &&
        typeof bodyJson === "object" &&
        "error" in (bodyJson as Record<string, unknown>)
          ? String((bodyJson as Record<string, unknown>).error)
          : (settlementError ?? `channel close failed with status ${response.status}`)),
    );
  }

  upsertStoredChannel(statePath, {
    ...stored,
    lifecycle_state: "closed",
    closed_tx_hash: extractSettlementField(settlement, "transaction"),
    updated_at: new Date().toISOString(),
  });
}

async function executeStateChannelRequest(
  opts: X402ChannelExecuteOptions,
  paymentRequired: PaymentRequired,
  offer: StateChannelOffer,
  statePath: string,
  channelContextKey: string,
): Promise<X402ChannelResult> {
  let current = resolveStoredChannelByKey(statePath, channelContextKey);
  const defaultDeposit =
    opts.depositOverride ?? opts.channelConfig?.default_deposit ?? offer.suggestedDeposit;
  const deposit = parseNonNegativeBigInt(defaultDeposit, "x402 channel deposit");
  const paymentAmount = BigInt(offer.price);

  const maxDepositAmount = parseNonNegativeBigInt(
    opts.channelConfig?.max_deposit_amount,
    "payments.x402.channel.max_deposit_amount",
  );
  if (amountExceedsCap(offer.price, opts.maxPaymentAmount) && !opts.yes) {
    throw new Error(
      `Payment amount ${offer.price} exceeds configured max_payment_amount ${opts.maxPaymentAmount}. Use --yes to override.`,
    );
  }

  if (
    current &&
    current.lifecycle_state === "open" &&
    BigInt(current.remaining_balance) < paymentAmount
  ) {
    await closeStateChannel(opts, paymentRequired, offer, current, statePath);
    current = null;
  }

  const openRequired = !current || current.lifecycle_state !== "open";
  if (openRequired && deposit === undefined) {
    throw new Error(
      "x402 channel deposit is required. Pass --x402-channel-deposit, configure payments.x402.channel.default_deposit, or rely on a server suggestedDeposit.",
    );
  }
  if (
    openRequired &&
    deposit !== undefined &&
    maxDepositAmount !== undefined &&
    deposit > maxDepositAmount &&
    !opts.yes
  ) {
    throw new Error(
      `Channel deposit ${deposit.toString()} exceeds configured max_deposit_amount ${maxDepositAmount.toString()}. Use --yes to override.`,
    );
  }

  let stored = current;
  let opened = false;

  if (openRequired) {
    const nonce = randomBytes(32);
    const channelId = deriveStateChannelId(opts.commitmentKeypair, nonce);
    const transaction = await buildStateOpenTransaction(
      opts.rpcUrl,
      opts.networkPassphrase,
      opts.payerKeypair,
      offer,
      opts.commitmentKeypair,
      deposit!,
      nonce,
    );
    const initialStateSignature = signStateHex(opts.commitmentKeypair, channelId, 0n, deposit!, 0n);
    const openPayload: PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: offer.accepted,
      payload: {
        action: "open",
        transaction,
        initialStateSignature,
      },
    };
    const response = await opts.fetchFn(opts.url, {
      method: opts.method ?? "GET",
      headers: paymentHeaders(openPayload, opts.headers),
      body: opts.body,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const bodyJson = parseResponseBody(body);
    const { settlement, settlementError } = parseSettlement(response, bodyJson);
    if (!response.ok) {
      throw new Error(
        extractSettlementField(settlement, "error") ??
          (bodyJson &&
          typeof bodyJson === "object" &&
          "error" in (bodyJson as Record<string, unknown>)
            ? String((bodyJson as Record<string, unknown>).error)
            : (settlementError ?? `channel open failed with status ${response.status}`)),
      );
    }

    const settledChannelId = extractSettlementField(settlement, "channelId");
    if (!settledChannelId) {
      throw new Error("x402 channel open response did not include channelId");
    }
    stored = upsertStoredChannel(statePath, {
      channel_id: settledChannelId,
      channel_context_key: channelContextKey,
      network_name: opts.networkName,
      network_passphrase: opts.networkPassphrase,
      resource_origin: new URL(opts.url).origin,
      resource_pathname: new URL(opts.url).pathname,
      asset: offer.asset,
      pay_to: offer.payTo,
      payer_public_key: opts.payerKeypair.publicKey(),
      payer_secret_ref: opts.payerSecretRef,
      commitment_public_key: opts.commitmentKeypair.publicKey(),
      commitment_secret_ref: opts.commitmentSecretRef,
      channel_contract_id: offer.channelContract,
      server_public_key: offer.serverPublicKey,
      price_per_request: offer.price,
      deposit: extractSettlementField(settlement, "deposit") ?? deposit!.toString(),
      current_cumulative: extractSettlementField(settlement, "currentCumulative") ?? "0",
      remaining_balance:
        extractSettlementField(settlement, "remainingBalance") ?? deposit!.toString(),
      current_iteration: extractSettlementField(settlement, "iteration") ?? "0",
      last_payment_signature: initialStateSignature,
      last_server_signature: extractSettlementField(settlement, "serverSig"),
      mode: "state",
      lifecycle_state: "open",
      opened_tx_hash: extractSettlementField(settlement, "transaction"),
      updated_at: new Date().toISOString(),
    });
    opened = true;
  }

  if (!stored) {
    throw new Error("x402 state channel did not open correctly");
  }

  const nextIteration = BigInt(stored.current_iteration ?? "0") + 1n;
  const nextCumulative = BigInt(stored.current_cumulative) + paymentAmount;
  const remainingBalance = BigInt(stored.deposit) - nextCumulative;
  if (remainingBalance < 0n) {
    throw new Error(
      `Channel balance ${stored.remaining_balance} is insufficient for payment amount ${offer.price}.`,
    );
  }

  const signature = signStateHex(
    opts.commitmentKeypair,
    stored.channel_id,
    nextIteration,
    remainingBalance,
    nextCumulative,
  );
  const payPayload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: offer.accepted,
    payload: {
      action: "pay",
      channelId: stored.channel_id,
      iteration: nextIteration.toString(),
      agentBalance: remainingBalance.toString(),
      serverBalance: nextCumulative.toString(),
      agentSig: signature,
    },
  };
  const response = await opts.fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: paymentHeaders(payPayload, opts.headers),
    body: opts.body,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const bodyJson = parseResponseBody(body);
  const { settlement, settlementError } = parseSettlement(response, bodyJson);

  if (!response.ok) {
    const error =
      extractSettlementField(settlement, "error") ??
      (bodyJson && typeof bodyJson === "object" && "error" in (bodyJson as Record<string, unknown>)
        ? String((bodyJson as Record<string, unknown>).error)
        : (settlementError ?? `channel pay failed with status ${response.status}`));
    throw new Error(error);
  }

  const updated = upsertStoredChannel(statePath, {
    ...stored,
    current_cumulative:
      extractSettlementField(settlement, "currentCumulative") ?? nextCumulative.toString(),
    remaining_balance:
      extractSettlementField(settlement, "remainingBalance") ?? remainingBalance.toString(),
    current_iteration: extractSettlementField(settlement, "iteration") ?? nextIteration.toString(),
    last_payment_signature: signature,
    last_server_signature: extractSettlementField(settlement, "serverSig"),
    lifecycle_state: remainingBalance === 0n ? "exhausted" : "open",
    updated_at: new Date().toISOString(),
  });

  return {
    kind: "channel",
    scheme: "channel",
    paid: true,
    status: response.status,
    body,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    paymentRequired,
    paymentPayload: payPayload,
    settlement,
    settlementError,
    channel: {
      action: opened ? "open+pay" : "pay",
      mode: "state",
      channel_id: updated.channel_id,
      deposit: updated.deposit,
      current_cumulative: updated.current_cumulative,
      remaining_balance: updated.remaining_balance,
      state_path: statePath,
      opened,
    },
  };
}

async function executeDemoChannelRequest(
  opts: X402ChannelExecuteOptions,
  paymentRequired: PaymentRequired,
  offer: DemoChannelOffer,
  statePath: string,
  channelContextKey: string,
): Promise<X402ChannelResult> {
  const current = resolveStoredChannelByKey(statePath, channelContextKey);
  const defaultDeposit =
    opts.depositOverride ??
    opts.channelConfig?.default_deposit ??
    offer.suggestedDeposit ??
    (BigInt(offer.price) * 100n).toString();
  const deposit =
    parseNonNegativeBigInt(defaultDeposit, "x402 channel deposit") ?? BigInt(offer.price) * 100n;
  const maxDepositAmount = parseNonNegativeBigInt(
    opts.channelConfig?.max_deposit_amount,
    "payments.x402.channel.max_deposit_amount",
  );
  if (maxDepositAmount !== undefined && deposit > maxDepositAmount && !opts.yes) {
    throw new Error(
      `Channel deposit ${deposit.toString()} exceeds configured max_deposit_amount ${maxDepositAmount.toString()}. Use --yes to override.`,
    );
  }
  if (amountExceedsCap(offer.price, opts.maxPaymentAmount) && !opts.yes) {
    throw new Error(
      `Payment amount ${offer.price} exceeds configured max_payment_amount ${opts.maxPaymentAmount}. Use --yes to override.`,
    );
  }

  const stored =
    current ??
    upsertStoredChannel(statePath, {
      channel_id: deriveDemoChannelId(opts.commitmentKeypair),
      channel_context_key: channelContextKey,
      network_name: opts.networkName,
      network_passphrase: opts.networkPassphrase,
      resource_origin: new URL(opts.url).origin,
      resource_pathname: new URL(opts.url).pathname,
      asset: offer.asset,
      pay_to: offer.payTo,
      payer_public_key: opts.payerKeypair.publicKey(),
      payer_secret_ref: opts.payerSecretRef,
      commitment_public_key: opts.commitmentKeypair.publicKey(),
      commitment_secret_ref: opts.commitmentSecretRef,
      server_public_key: offer.serverPublicKey,
      price_per_request: offer.price,
      deposit: deposit.toString(),
      current_cumulative: "0",
      remaining_balance: deposit.toString(),
      current_iteration: "0",
      mode: "demo",
      lifecycle_state: "open",
      updated_at: new Date().toISOString(),
    });

  const nextIteration = BigInt(stored.current_iteration ?? "0") + 1n;
  const nextCumulative = BigInt(stored.current_cumulative) + BigInt(offer.price);
  const remainingBalance = BigInt(stored.deposit) - nextCumulative;
  if (remainingBalance < 0n) {
    throw new Error(
      `Channel balance ${stored.remaining_balance} is insufficient for payment amount ${offer.price}.`,
    );
  }
  const signature = signStateHex(
    opts.commitmentKeypair,
    stored.channel_id,
    nextIteration,
    remainingBalance,
    nextCumulative,
  );

  const payPayload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted: offer.accepted,
    payload: {
      scheme: "channel",
      mode: "stateless-demo",
      channelId: stored.channel_id,
      iteration: nextIteration.toString(),
      agentBalance: remainingBalance.toString(),
      serverBalance: nextCumulative.toString(),
      deposit: stored.deposit,
      agentPublicKey: opts.commitmentKeypair.publicKey(),
      agentSig: signature,
    },
  };
  const response = await opts.fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: paymentHeaders(payPayload, opts.headers),
    body: opts.body,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const bodyJson = parseResponseBody(body);
  const { settlement, settlementError } = parseSettlement(response, bodyJson);
  upsertStoredChannel(statePath, {
    ...stored,
    current_cumulative: nextCumulative.toString(),
    remaining_balance: remainingBalance.toString(),
    current_iteration: nextIteration.toString(),
    last_payment_signature: signature,
    lifecycle_state: remainingBalance === 0n ? "exhausted" : "open",
    updated_at: new Date().toISOString(),
  });

  return {
    kind: "channel",
    scheme: "channel",
    paid: true,
    status: response.status,
    body,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    paymentRequired,
    paymentPayload: payPayload,
    settlement,
    settlementError,
    channel: {
      action: current ? "pay" : "open+pay",
      mode: "demo",
      channel_id: stored.channel_id,
      deposit: stored.deposit,
      current_cumulative: nextCumulative.toString(),
      remaining_balance: remainingBalance.toString(),
      state_path: statePath,
      opened: !current,
    },
  };
}

export async function executeX402ChannelRequest(
  opts: X402ChannelExecuteOptions,
): Promise<X402ChannelResult | X402ChannelFallbackResult> {
  const { response, bytes, bodyJson } = await sendInitialRequest(opts);
  if (response.status !== 402) {
    return {
      kind: "channel",
      scheme: "channel",
      paid: false,
      status: response.status,
      body: bytes,
      responseHeaders: Object.fromEntries(response.headers.entries()),
    };
  }

  const paymentRequired = parsePaymentRequired(response, bodyJson);
  const accepted = selectChannelAccept(paymentRequired, opts.x402Network);
  if (!accepted) {
    if (opts.schemeSelection === "auto") {
      return { kind: "fallback-exact" };
    }
    throw new Error(
      `No matching x402 payment option for network ${opts.x402Network} with scheme "channel".`,
    );
  }

  if (opts.dryRun) {
    return {
      kind: "channel",
      scheme: "channel",
      paid: false,
      status: 402,
      body: bytes,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      paymentRequired,
    };
  }

  const offer = normalizeChannelOffer(accepted);
  const statePath =
    opts.statePathOverride ?? resolveX402ChannelStatePath(opts.configPath, opts.channelConfig);
  const channelContextKey = makeChannelContextKey(
    opts.url,
    opts.networkName,
    offer,
    opts.payerKeypair.publicKey(),
  );

  if (offer.mode === "state") {
    return executeStateChannelRequest(opts, paymentRequired, offer, statePath, channelContextKey);
  }

  return executeDemoChannelRequest(opts, paymentRequired, offer, statePath, channelContextKey);
}
