import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { X402ChannelConfig } from "../config.js";
import type { StoredX402Channel } from "./types.js";

interface StoredX402ChannelFile {
  active_channel_by_key: Record<string, string>;
  channels: Record<string, StoredX402Channel>;
}

function emptyChannelFile(): StoredX402ChannelFile {
  return {
    active_channel_by_key: {},
    channels: {},
  };
}

function readChannelFile(path: string): StoredX402ChannelFile {
  if (!existsSync(path)) return emptyChannelFile();
  return JSON.parse(readFileSync(path, "utf8")) as StoredX402ChannelFile;
}

function writeChannelFile(path: string, data: StoredX402ChannelFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function resolveX402ChannelStatePath(
  configPath: string,
  channelConfig?: X402ChannelConfig,
): string {
  if (channelConfig?.state_file) {
    return resolvePath(dirname(configPath), channelConfig.state_file);
  }
  return resolvePath(dirname(configPath), `${configPath.split("/").pop()}.x402-channels.json`);
}

export function resolveStoredChannelByKey(
  statePath: string,
  channelContextKey: string,
): StoredX402Channel | null {
  const file = readChannelFile(statePath);
  const channelId = file.active_channel_by_key[channelContextKey];
  if (!channelId) return null;
  return file.channels[channelId] ?? null;
}

export function upsertStoredChannel(
  statePath: string,
  channel: StoredX402Channel,
): StoredX402Channel {
  const file = readChannelFile(statePath);
  file.active_channel_by_key[channel.channel_context_key] = channel.channel_id;
  file.channels[channel.channel_id] = channel;
  writeChannelFile(statePath, file);
  return channel;
}
