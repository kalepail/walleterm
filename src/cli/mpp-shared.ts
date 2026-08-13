import type { WalletermConfig } from "../config.js";
import { resolveMppStatePath } from "../mpp-channel.js";

export function resolveMppChannelStatePath(configPath: string, config: WalletermConfig): string {
  return resolveMppStatePath(configPath, config.payments?.mpp?.channel);
}
