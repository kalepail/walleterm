import { Command } from "commander";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { signConfiguredInput, writeOutput } from "../core.js";
import { loadConfig } from "../config.js";
import { SecretResolver } from "../secrets.js";
import {
  buildSignerMutationBundle,
  makeDelegatedSignerScVal,
  makeExternalSignerScVal,
} from "../wallet.js";
import {
  buildKeypairJson,
  credentialIdFromKeypair,
  parseOptionalInt,
  requireNonNegativeInt,
} from "./shared.js";

interface WalletMutationOpts {
  config: string;
  network?: string;
  account: string;
  out: string;
  contextRuleId: string;
  ttlSeconds?: string;
  latestLedger?: string;
  delegatedAddress?: string;
  secretRef?: string;
  verifierContractId?: string;
  publicKeyHex?: string;
}

async function resolveSignerMutationTarget(
  opts: WalletMutationOpts,
): Promise<{ signerScVal: xdr.ScVal; signerDescriptor: Record<string, unknown> }> {
  const hasSecretRef = Boolean(opts.secretRef);
  const hasDelegatedAddress = Boolean(opts.delegatedAddress);
  const hasVerifierContractId = Boolean(opts.verifierContractId);
  const hasPublicKeyHex = Boolean(opts.publicKeyHex);

  if (hasSecretRef && (hasDelegatedAddress || hasPublicKeyHex)) {
    throw new Error("Use either --secret-ref or direct signer identity flags, not both.");
  }

  if (hasDelegatedAddress && (hasVerifierContractId || hasPublicKeyHex)) {
    throw new Error(
      "Delegated signer mutations accept only --delegated-address, or use --secret-ref.",
    );
  }

  if (hasPublicKeyHex && !hasVerifierContractId) {
    throw new Error(
      "External signer mutations require --verifier-contract-id with --public-key-hex.",
    );
  }

  if (hasVerifierContractId && !hasSecretRef && !hasPublicKeyHex) {
    throw new Error("External signer mutations require either --public-key-hex or --secret-ref.");
  }

  if (hasSecretRef) {
    const resolver = new SecretResolver();
    try {
      const secret = await resolver.resolve(opts.secretRef!);
      let keypair: Keypair;
      try {
        keypair = Keypair.fromSecret(secret);
      } catch {
        throw new Error("secret-ref must resolve to a valid Stellar secret seed (S...)");
      }

      if (hasVerifierContractId) {
        const publicKeyHex = credentialIdFromKeypair(keypair);
        return {
          signerScVal: makeExternalSignerScVal(opts.verifierContractId!, publicKeyHex),
          signerDescriptor: {
            type: "External",
            verifier_contract_id: opts.verifierContractId,
            public_key_hex: publicKeyHex,
            secret_ref: opts.secretRef,
          },
        };
      }

      const delegatedAddress = keypair.publicKey();
      return {
        signerScVal: makeDelegatedSignerScVal(delegatedAddress),
        signerDescriptor: {
          type: "Delegated",
          address: delegatedAddress,
          secret_ref: opts.secretRef,
        },
      };
    } finally {
      resolver.clearCache();
    }
  }

  if (hasDelegatedAddress) {
    return {
      signerScVal: makeDelegatedSignerScVal(opts.delegatedAddress!),
      signerDescriptor: {
        type: "Delegated",
        address: opts.delegatedAddress,
      },
    };
  }

  if (hasVerifierContractId && hasPublicKeyHex) {
    return {
      signerScVal: makeExternalSignerScVal(opts.verifierContractId!, opts.publicKeyHex!),
      signerDescriptor: {
        type: "External",
        verifier_contract_id: opts.verifierContractId,
        public_key_hex: opts.publicKeyHex,
      },
    };
  }

  throw new Error(
    "Pass a signer target using --secret-ref, --delegated-address, or --verifier-contract-id with --public-key-hex.",
  );
}

async function runSignerMutation(
  opts: WalletMutationOpts,
  functionName: "add_signer" | "remove_signer",
  signerScVal: xdr.ScVal,
  signerDescriptor: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig(opts.config);
  let contextRuleId: number | undefined;
  const { output, report, contractId } = await signConfiguredInput({
    config,
    network: opts.network,
    account: opts.account,
    ttlSeconds: parseOptionalInt(opts.ttlSeconds),
    latestLedger: parseOptionalInt(opts.latestLedger),
    input: ({ contractId: selectedContractId, expirationLedger }) => {
      contextRuleId = requireNonNegativeInt(
        parseOptionalInt(opts.contextRuleId),
        "context-rule-id",
      );
      return buildSignerMutationBundle(
        selectedContractId,
        functionName,
        contextRuleId,
        signerScVal,
        expirationLedger,
      );
    },
  });

  writeOutput(opts.out, output);
  process.stdout.write(
    `${JSON.stringify({
      operation: functionName,
      contract_id: contractId,
      context_rule_id: contextRuleId,
      target_signer: signerDescriptor,
      ...report,
    })}\n`,
  );
}

export function registerWalletSignerCommands(wallet: Command): void {
  const signer = wallet.command("signer").description("manage smart-account signers");

  signer
    .command("generate")
    .description("generate a new Stellar signer keypair")
    .action(() => {
      process.stdout.write(`${JSON.stringify(buildKeypairJson(Keypair.random()))}\n`);
    });

  async function runSignerMutationCommand(
    opts: WalletMutationOpts,
    functionName: "add_signer" | "remove_signer",
  ): Promise<void> {
    const { signerScVal, signerDescriptor } = await resolveSignerMutationTarget(opts);
    await runSignerMutation(opts, functionName, signerScVal, signerDescriptor);
  }

  signer
    .command("add")
    .description("build and sign an add_signer bundle")
    .requiredOption("--account <alias>", "smart account alias")
    .option("--context-rule-id <n>", "context rule id (default: 0)", "0")
    .requiredOption("--out <path>", "output bundle json path")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--ttl-seconds <n>", "auth ttl in seconds")
    .option("--latest-ledger <n>", "override latest ledger sequence")
    .option("--secret-ref <ref>", "derive signer identity from secret ref")
    .option("--delegated-address <g-address>", "delegated signer G-address")
    .option("--verifier-contract-id <contract-id>", "verifier contract C-address")
    .option("--public-key-hex <hex>", "32-byte ed25519 public key hex")
    .action(async (opts: WalletMutationOpts) => {
      await runSignerMutationCommand(opts, "add_signer");
    });

  signer
    .command("remove")
    .description("build and sign a remove_signer bundle")
    .requiredOption("--account <alias>", "smart account alias")
    .option("--context-rule-id <n>", "context rule id (default: 0)", "0")
    .requiredOption("--out <path>", "output bundle json path")
    .option("--config <path>", "config TOML path", "walleterm.toml")
    .option("--network <name>", "network name")
    .option("--ttl-seconds <n>", "auth ttl in seconds")
    .option("--latest-ledger <n>", "override latest ledger sequence")
    .option("--secret-ref <ref>", "derive signer identity from secret ref")
    .option("--delegated-address <g-address>", "delegated signer G-address")
    .option("--verifier-contract-id <contract-id>", "verifier contract C-address")
    .option("--public-key-hex <hex>", "32-byte ed25519 public key hex")
    .action(async (opts: WalletMutationOpts) => {
      await runSignerMutationCommand(opts, "remove_signer");
    });
}
