import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./config.js";
import type { ParsedInput } from "./core.js";
import { SecretResolver } from "./secrets.js";

export interface SubmitNetworkOverrides {
  channelsBaseUrl?: string;
  channelsApiKey?: string;
  channelsApiKeyRef?: string;
  pluginId?: string;
}

export interface SubmitResult {
  mode: "channels";
  request_kind: "tx" | "bundle";
  hash: string | null;
  status: string | null;
  transaction_id: string | null;
}

function readDirectOrSecretRef(raw: string, resolver: SecretResolver): Promise<string> {
  if (raw.startsWith("op://")) {
    return resolver.resolve(raw);
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

  return {
    baseUrl,
    apiKey,
    pluginId: overrides.pluginId,
  };
}

export async function submitViaChannels(
  parsed: ParsedInput,
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
    : new ChannelsClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });

  if (parsed.kind === "tx") {
    const response = await client.submitTransaction({
      xdr: parsed.envelope.toXDR("base64"),
    });
    return {
      mode: "channels",
      request_kind: "tx",
      hash: response.hash,
      status: response.status,
      transaction_id: response.transactionId,
    };
  }

  if (parsed.kind === "bundle") {
    if (!parsed.func) {
      throw new Error("Bundle submission requires 'func' field");
    }
    const response = await client.submitSorobanTransaction({
      func: parsed.func,
      auth: parsed.auth.map((entry) => entry.toXDR("base64")),
    });
    return {
      mode: "channels",
      request_kind: "bundle",
      hash: response.hash,
      status: response.status,
      transaction_id: response.transactionId,
    };
  }

  throw new Error("Submitting a standalone auth entry is not supported. Submit tx or bundle.");
}

export async function submitTxXdrViaRpc(
  signedTxXdr: string,
  network: NetworkConfig,
): Promise<{
  status: string;
  hash: string;
  latestLedger: number;
  latestLedgerCloseTime: number;
}> {
  const tx = TransactionBuilder.fromXDR(signedTxXdr, network.network_passphrase);
  const result = await new rpc.Server(network.rpc_url).sendTransaction(tx);
  return {
    status: result.status,
    hash: result.hash,
    latestLedger: result.latestLedger,
    latestLedgerCloseTime: result.latestLedgerCloseTime,
  };
}
