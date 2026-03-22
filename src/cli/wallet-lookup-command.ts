import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import { listSignerConfig } from "../core.js";
import { loadConfig, resolveNetwork } from "../config.js";
import { SecretResolver } from "../secrets.js";
import {
  discoverContractsByAddress,
  discoverContractsByCredentialId,
  type IndexerContractSummary,
  listContractSigners,
  resolveIndexerUrl,
} from "../wallet.js";
import { credentialIdFromKeypair } from "./shared.js";

interface WalletLookupOpts {
  config: string;
  network?: string;
  account?: string;
  indexerUrl?: string;
  address?: string;
  contractId?: string;
  secretRef?: string;
}

function dedupeContractsById(contracts: IndexerContractSummary[]): IndexerContractSummary[] {
  const byId = new Map<string, IndexerContractSummary>();
  for (const contract of contracts) {
    byId.set(contract.contract_id, contract);
  }
  return [...byId.values()];
}

async function enrichContractsWithOnchainSigners(
  indexerUrl: string,
  contracts: Array<
    IndexerContractSummary & {
      lookup_types?: string[];
    }
  >,
): Promise<
  Array<IndexerContractSummary & { lookup_types?: string[]; onchain_signers: unknown[] }>
> {
  return Promise.all(
    contracts.map(async (contract) => ({
      ...contract,
      onchain_signers: (await listContractSigners(indexerUrl, contract.contract_id)).signers,
    })),
  );
}

export function registerWalletLookupCommand(wallet: Command): void {
  wallet
    .command("lookup")
    .description("resolve a signer, wallet, or contract into the smart-account view")
    .option("--account <alias>", "configured smart account alias")
    .option("--address <stellar-address>", "G... or C... address")
    .option("--contract-id <contract-id>", "smart account contract C-address")
    .option("--secret-ref <ref>", "secret ref to Stellar secret seed")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--indexer-url <url>", "override indexer base URL")
    .action(async (opts: WalletLookupOpts) => {
      const config = loadConfig(opts.config);
      const { name: networkName, config: network } = resolveNetwork(config, opts.network);
      const indexerUrl = resolveIndexerUrl(network, opts.indexerUrl);

      const selectors = [opts.account, opts.address, opts.contractId, opts.secretRef].filter(
        Boolean,
      );
      if (selectors.length !== 1) {
        throw new Error(
          "Pass exactly one of --account, --address, --contract-id, or --secret-ref.",
        );
      }

      if (opts.account) {
        const accountAlias = opts.account;
        const account = config.smart_accounts[accountAlias];
        if (!account) throw new Error(`Smart account '${accountAlias}' not found`);
        if (account.network !== networkName) {
          throw new Error(
            `Smart account '${accountAlias}' belongs to network '${account.network}', not '${networkName}'`,
          );
        }

        const local = listSignerConfig({ alias: accountAlias, account });
        const onchain = await listContractSigners(indexerUrl, account.contract_id);
        process.stdout.write(
          `${JSON.stringify({
            mode: "account",
            query: { account: accountAlias },
            count: 1,
            wallets: [
              {
                contract_id: account.contract_id,
                configured_account: accountAlias,
                configured_signers: local,
                onchain_signers: onchain.signers,
              },
            ],
          })}\n`,
        );
        return;
      }

      if (opts.contractId || opts.address?.startsWith("C")) {
        const contractId = opts.contractId ?? opts.address!;
        const onchain = await listContractSigners(indexerUrl, contractId);
        process.stdout.write(
          `${JSON.stringify({
            mode: "contract",
            query: { contract_id: contractId },
            count: 1,
            wallets: [{ contract_id: contractId, onchain_signers: onchain.signers }],
          })}\n`,
        );
        return;
      }

      if (opts.address) {
        const discovered = await discoverContractsByAddress(indexerUrl, opts.address);
        const contracts = await enrichContractsWithOnchainSigners(
          indexerUrl,
          dedupeContractsById(discovered.contracts).map((contract) => ({
            ...contract,
            lookup_types: ["delegated"],
          })),
        );
        process.stdout.write(
          `${JSON.stringify({
            mode: "address",
            query: { address: opts.address },
            count: contracts.length,
            wallets: contracts,
          })}\n`,
        );
        return;
      }

      const resolver = new SecretResolver();
      try {
        const secret = await resolver.resolve(opts.secretRef!);
        let keypair: Keypair;
        try {
          keypair = Keypair.fromSecret(secret);
        } catch {
          throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
        }

        const signerAddress = keypair.publicKey();
        const credentialId = credentialIdFromKeypair(keypair);
        const [delegated, external] = await Promise.all([
          discoverContractsByAddress(indexerUrl, signerAddress),
          discoverContractsByCredentialId(indexerUrl, credentialId),
        ]);
        const sourceByContractId = new Map<string, Set<"delegated" | "external">>();
        for (const contract of delegated.contracts) {
          const existing = sourceByContractId.get(contract.contract_id) ?? new Set();
          existing.add("delegated");
          sourceByContractId.set(contract.contract_id, existing);
        }
        for (const contract of external.contracts) {
          const existing = sourceByContractId.get(contract.contract_id) ?? new Set();
          existing.add("external");
          sourceByContractId.set(contract.contract_id, existing);
        }
        const contracts = await enrichContractsWithOnchainSigners(
          indexerUrl,
          dedupeContractsById([...delegated.contracts, ...external.contracts]).map((contract) => {
            const lookupTypes = sourceByContractId.get(contract.contract_id)!;
            return {
              ...contract,
              lookup_types: [...lookupTypes],
            };
          }),
        );
        process.stdout.write(
          `${JSON.stringify({
            mode: "secret-ref",
            query: {
              secret_ref: opts.secretRef,
              derived_address: signerAddress,
              credential_id: credentialId,
            },
            count: contracts.length,
            wallets: contracts,
          })}\n`,
        );
      } finally {
        resolver.clearCache();
      }
    });
}
