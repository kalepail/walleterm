import { Address } from "@stellar/stellar-sdk";
import type { SmartAccountConfig, WalletermConfig } from "../config.js";
import { findAccountByContractId, resolveAccount } from "../config.js";
import type { AccountRef, ParsedInput } from "./types.js";

export function selectAccountForAddress(
  config: WalletermConfig,
  networkName: string,
  currentAccountRef: AccountRef | null,
  address: string,
): AccountRef | null {
  if (currentAccountRef && currentAccountRef.account.contract_id === address) {
    return currentAccountRef;
  }

  return findAccountByContractId(config, networkName, address);
}

export function resolveAccountForCommand(
  config: WalletermConfig,
  networkName: string,
  explicitAccountAlias: string | undefined,
  parsed: ParsedInput,
): AccountRef | null {
  const explicit = resolveAccount(config, networkName, explicitAccountAlias);
  if (explicit) return explicit;

  if (parsed.kind !== "tx") {
    for (const auth of parsed.auth) {
      if (auth.credentials().switch().name !== "sorobanCredentialsAddress") continue;
      const address = Address.fromScAddress(auth.credentials().address().address()).toString();
      if (!address.startsWith("C")) continue;
      const found = findAccountByContractId(config, networkName, address);
      if (found) return found;
    }
  }

  return resolveAccount(config, networkName, undefined);
}

export type { SmartAccountConfig };
