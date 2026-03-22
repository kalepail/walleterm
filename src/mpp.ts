import { Challenge, Credential, Receipt } from "mppx";
import { stellar as createMppChargeMethod } from "stellar-mpp-sdk/client";
import { stellar as createMppChannelMethod } from "stellar-mpp-sdk/channel/client";

export type MppNetwork = "public" | "testnet";
export type MppIntent = "charge" | "channel";
export type MppChannelAction = "close" | "voucher";
export type MppChargeMode = "pull" | "push";

const PASSPHRASE_TO_MPP_NETWORK = new Map<string, MppNetwork>([
  ["Test SDF Network ; September 2015", "testnet"],
  ["Public Global Stellar Network ; September 2015", "public"],
]);

export function passphraseToMppNetwork(passphrase: string): MppNetwork {
  const network = PASSPHRASE_TO_MPP_NETWORK.get(passphrase);
  if (!network) {
    throw new Error(`No MPP network mapping for passphrase: ${passphrase}`);
  }
  return network;
}

export interface MppChallenge {
  id: string;
  intent: MppIntent;
  method: string;
  realm: string;
  request: Record<string, unknown> & {
    amount?: string;
    methodDetails?: Record<string, unknown>;
  };
}

export interface MppPaymentAttempt {
  challenge: MppChallenge;
  payload: unknown;
  source?: string;
}

export interface MppReceipt {
  method: string;
  reference: string;
  externalId?: string;
  status: "success";
  timestamp: string;
}

export interface MppClientMethod {
  name: string;
  intent: MppIntent;
  createCredential(parameters: {
    challenge: MppChallenge;
    context?: Record<string, unknown>;
  }): Promise<string>;
}

export interface CreateMppClientMethodOptions {
  intent: MppIntent;
  secret: string;
  rpcUrl?: string;
  sourceAccount?: string;
  chargeMode?: MppChargeMode;
}

export function createMppClientMethod(opts: CreateMppClientMethodOptions): MppClientMethod {
  if (opts.intent === "charge") {
    return createMppChargeMethod({
      secretKey: opts.secret,
      rpcUrl: opts.rpcUrl,
      mode: opts.chargeMode,
    }) as unknown as MppClientMethod;
  }

  return createMppChannelMethod({
    commitmentSecret: opts.secret,
    rpcUrl: opts.rpcUrl,
    sourceAccount: opts.sourceAccount,
  }) as unknown as MppClientMethod;
}

export interface MppFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  intent: MppIntent;
  network: MppNetwork;
  dryRun?: boolean;
  maxPaymentAmount?: string;
  yes?: boolean;
  context?: Record<string, unknown>;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface MppResult {
  paid: boolean;
  status: number;
  body: Uint8Array;
  responseHeaders: Record<string, string>;
  challenge?: MppChallenge;
  paymentAttempt?: MppPaymentAttempt;
  settlement?: MppReceipt;
  settlementError?: string;
}

function normalizeChallengeNetwork(challenge: MppChallenge, network: MppNetwork): MppChallenge {
  const methodDetails = challenge.request.methodDetails;
  if (typeof methodDetails?.network === "string") {
    return challenge;
  }

  return {
    ...challenge,
    request: {
      ...challenge.request,
      methodDetails: {
        ...methodDetails,
        network,
      },
    },
  };
}

function amountExceedsCap(amount: string | undefined, max: string | undefined): boolean {
  if (!amount || !max) return false;

  const amountNum = Number(amount);
  const maxNum = Number(max);
  if (!Number.isFinite(amountNum) || !Number.isFinite(maxNum)) {
    return false;
  }

  return amountNum > maxNum;
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function selectChallenge(
  challenges: MppChallenge[],
  methods: MppClientMethod[],
  intent: MppIntent,
): {
  challenge: MppChallenge;
  client: MppClientMethod;
} {
  for (const challenge of challenges) {
    const client = methods.find(
      (method) => method.name === challenge.method && method.intent === challenge.intent,
    );
    if (client && challenge.intent === intent) {
      return { challenge, client };
    }
  }

  const available = challenges
    .map((challenge) => `${challenge.method}/${challenge.intent}`)
    .join(", ");
  throw new Error(
    `No matching MPP payment option for intent "${intent}". Available: ${available || "none"}`,
  );
}

/* v8 ignore start -- command-layer tests cover these branches, but v8 branch accounting is noisy here */
export async function executeMppRequest(
  methods: MppClientMethod[],
  opts: MppFetchOptions,
): Promise<MppResult> {
  const initialResponse = await opts.fetchFn(opts.url, {
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

  const rawChallenges = Challenge.fromResponseList(initialResponse) as unknown as MppChallenge[];
  const { challenge: selectedChallenge, client } = selectChallenge(
    rawChallenges,
    methods,
    opts.intent,
  );
  const challenge = normalizeChallengeNetwork(selectedChallenge, opts.network);

  const initialBody = new Uint8Array(await initialResponse.arrayBuffer());
  if (opts.dryRun) {
    return {
      paid: false,
      status: 402,
      body: initialBody,
      responseHeaders: Object.fromEntries(initialResponse.headers.entries()),
      challenge,
    };
  }

  if (amountExceedsCap(challenge.request.amount, opts.maxPaymentAmount) && !opts.yes) {
    throw new Error(
      `Payment amount ${challenge.request.amount} exceeds configured max_payment_amount ${opts.maxPaymentAmount}. Use --yes to override.`,
    );
  }

  if (hasAuthorizationHeader(opts.headers)) {
    throw new Error("MPP payment flow cannot be combined with an existing Authorization header.");
  }

  process.stderr.write(
    `mpp: paying via ${challenge.method}/${challenge.intent} in ${challenge.realm}\n`,
  );

  const authorization = await client.createCredential(
    opts.context === undefined ? { challenge } : { challenge, context: opts.context },
  );
  const paymentAttempt = Credential.deserialize(authorization) as unknown as MppPaymentAttempt;

  const retryResponse = await opts.fetchFn(opts.url, {
    method: opts.method ?? "GET",
    headers: { ...opts.headers, Authorization: authorization },
    body: opts.body,
  });

  let settlement: MppReceipt | undefined;
  let settlementError: string | undefined;
  try {
    settlement = Receipt.fromResponse(retryResponse) as unknown as MppReceipt;
  } catch (error) {
    settlementError = error instanceof Error ? error.message : String(error);
  }

  return {
    paid: true,
    status: retryResponse.status,
    body: new Uint8Array(await retryResponse.arrayBuffer()),
    responseHeaders: Object.fromEntries(retryResponse.headers.entries()),
    challenge,
    paymentAttempt,
    settlement,
    settlementError,
  };
}
/* v8 ignore stop */
