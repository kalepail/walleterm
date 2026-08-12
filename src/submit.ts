import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { resolveNetwork, type NetworkConfig, type WalletermConfig } from "./config.js";
import type { ParsedInput } from "./core.js";
import { SecretResolver, looksLikeSecretRef } from "./secrets.js";

export type SubmitMode = "channels" | "rpc";

export interface SubmitNetworkOverrides {
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}

export type ConfiguredSubmitInput = ParsedInput | { kind: "signed-tx"; xdr: string };

export interface ConfiguredSubmitRequest {
  config: WalletermConfig;
  input: ConfiguredSubmitInput;
  network?: string;
  mode?: string;
  trigger?: "always" | "configured";
  channels?: SubmitNetworkOverrides;
}

export type SubmitResult =
  | {
      mode: "channels";
      request_kind: "tx" | "bundle";
      hash: string | null;
      status: string | null;
      transaction_id: string | null;
    }
  | {
      mode: "rpc";
      request_kind: "tx";
      status: string;
      hash: string;
      latestLedger: number;
      latestLedgerCloseTime: number;
    };

type SubmissionPayload =
  | { kind: "tx"; xdr: string }
  | { kind: "bundle"; func?: string; auth: string[] }
  | { kind: "auth" };

function resolveSubmitMode(raw: string | undefined): SubmitMode {
  const mode = raw ?? "channels";
  if (mode !== "channels" && mode !== "rpc") {
    throw new Error(`Unsupported submit mode '${mode}'. Expected channels or rpc.`);
  }
  return mode;
}

function normalizeInput(input: ConfiguredSubmitInput): SubmissionPayload {
  if (input.kind === "signed-tx") {
    return { kind: "tx", xdr: input.xdr };
  }
  if (input.kind === "tx") {
    return { kind: "tx", xdr: input.envelope.toXDR("base64") };
  }
  if (input.kind === "bundle") {
    return {
      kind: "bundle",
      func: input.func,
      auth: input.auth.map((entry) => entry.toXDR("base64")),
    };
  }
  return { kind: "auth" };
}

function validateInput(mode: SubmitMode, payload: SubmissionPayload): void {
  if (mode === "rpc" && payload.kind !== "tx") {
    throw new Error("RPC submission currently supports signed tx envelope input only.");
  }
  if (mode === "channels" && payload.kind === "auth") {
    throw new Error("Submitting a standalone auth entry is not supported. Submit tx or bundle.");
  }
  if (mode === "channels" && payload.kind === "bundle" && !payload.func) {
    throw new Error("Bundle submission requires 'func' field");
  }
}

function readDirectOrSecretRef(raw: string, resolver: SecretResolver): Promise<string> {
  if (resolver.isSupportedRef(raw)) {
    return resolver.resolve(raw);
  }
  if (looksLikeSecretRef(raw)) {
    throw new Error(
      `Unsupported secret ref '${raw}'. Supported schemes: ${resolver
        .supportedSchemes()
        .map((value) => `${value}://`)
        .join(", ")}.`,
    );
  }
  return Promise.resolve(raw);
}

async function resolveChannelsConfig(
  network: NetworkConfig,
  resolver: SecretResolver,
  overrides: SubmitNetworkOverrides,
): Promise<{ baseUrl: string; apiKey: string; pluginId?: string }> {
  const baseUrl = overrides.channelsBaseUrl ?? network.channels_base_url;
  if (!baseUrl) {
    throw new Error(
      "Channels base URL is required. Configure networks.<name>.channels_base_url or pass --channels-base-url.",
    );
  }

  let apiKey = overrides.channelsApiKey;
  if (!apiKey && overrides.channelsApiKeyRef) {
    apiKey = await readDirectOrSecretRef(overrides.channelsApiKeyRef, resolver);
  }
  if (!apiKey && network.channels_api_key_ref) {
    apiKey = await readDirectOrSecretRef(network.channels_api_key_ref, resolver);
  }
  if (!apiKey) {
    throw new Error(
      "Channels API key is required. Set networks.<name>.channels_api_key_ref or pass --channels-api-key/--channels-api-key-ref.",
    );
  }

  return { baseUrl, apiKey, pluginId: overrides.pluginId };
}

async function submitViaChannels(
  payload: Extract<SubmissionPayload, { kind: "tx" | "bundle" }>,
  network: NetworkConfig,
  resolver: SecretResolver,
  overrides: SubmitNetworkOverrides,
): Promise<SubmitResult> {
  const config = await resolveChannelsConfig(network, resolver, overrides);
  const client = config.pluginId
    ? new ChannelsClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        pluginId: config.pluginId,
      })
    : new ChannelsClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  const response =
    payload.kind === "tx"
      ? await client.submitTransaction({ xdr: payload.xdr })
      : await client.submitSorobanTransaction({ func: payload.func!, auth: payload.auth });

  return {
    mode: "channels",
    request_kind: payload.kind,
    hash: response.hash,
    status: response.status,
    transaction_id: response.transactionId,
  };
}

async function submitViaRpc(
  payload: Extract<SubmissionPayload, { kind: "tx" }>,
  network: NetworkConfig,
): Promise<SubmitResult> {
  const tx = TransactionBuilder.fromXDR(payload.xdr, network.network_passphrase);
  const result = await new rpc.Server(network.rpc_url).sendTransaction(tx);
  return {
    mode: "rpc",
    request_kind: "tx",
    status: result.status,
    hash: result.hash,
    latestLedger: result.latestLedger,
    latestLedgerCloseTime: result.latestLedgerCloseTime,
  };
}

export async function submitConfiguredInput(
  request: ConfiguredSubmitRequest,
): Promise<SubmitResult | null> {
  if (request.trigger === "configured" && request.config.app.default_submit_mode !== "channels") {
    return null;
  }

  const mode = resolveSubmitMode(request.mode);
  const payload = normalizeInput(request.input);
  validateInput(mode, payload);
  const { config: network } = resolveNetwork(request.config, request.network);

  if (mode === "rpc") {
    return submitViaRpc(payload as Extract<SubmissionPayload, { kind: "tx" }>, network);
  }

  const resolver = new SecretResolver();
  try {
    return await submitViaChannels(
      payload as Extract<SubmissionPayload, { kind: "tx" | "bundle" }>,
      network,
      resolver,
      request.channels ?? {},
    );
  } finally {
    resolver.clearCache();
  }
}
