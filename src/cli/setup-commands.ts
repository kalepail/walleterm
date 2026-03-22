import { Command } from "commander";
import { defaultServiceForNetwork, setupMacOSKeychainForWallet } from "../keychain-setup.js";
import { defaultItemForNetwork, setupOnePasswordForWallet } from "../op-setup.js";
import { generateSshAgentKey, setupSshAgentForWallet } from "../ssh-agent-setup.js";

interface SetupOpOpts {
  vault: string;
  item?: string;
  network: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  force?: boolean;
  createVault: boolean;
  json?: boolean;
}

interface SetupKeychainOpts {
  service?: string;
  network: string;
  keychain?: string;
  deployerSeed?: string;
  delegatedSeed?: string;
  channelsApiKey?: string;
  includeDeployerSeed?: boolean;
  force?: boolean;
  json?: boolean;
}

interface SetupSshAgentOpts {
  backend: string;
  socket?: string;
  json?: boolean;
  generate?: boolean;
  vault?: string;
  title?: string;
  keyPath?: string;
}

export function registerSetupCommands(program: Command): void {
  const setup = program.command("setup").description("environment and secret setup");

  setup
    .command("op")
    .description("bootstrap 1Password secrets for wallet creation/signing")
    .option("--vault <name>", "1Password vault name", "Private")
    .option(
      "--item <name>",
      "1Password item name (default: walleterm-testnet or walleterm-mainnet by network)",
    )
    .option("--network <name>", "network context (used for defaults)", "testnet")
    .option(
      "--deployer-seed <seed>",
      "existing deployer S... seed (if provided, it will be stored)",
    )
    .option("--delegated-seed <seed>", "existing delegated S... seed (defaults to generated)")
    .option(
      "--channels-api-key <key>",
      "channels API key (defaults to auto-generated on testnet/mainnet)",
    )
    .option(
      "--include-deployer-seed",
      "store deployer seed in 1Password (default uses smart-account-kit deterministic deployer)",
      false,
    )
    .option("--force", "overwrite existing item fields", false)
    .option("--no-create-vault", "fail instead of creating missing vault")
    .option("--json", "print only json output", false)
    .action(async (opts: SetupOpOpts) => {
      const networkName = opts.network;
      const result = await setupOnePasswordForWallet({
        vault: opts.vault,
        item: opts.item ?? defaultItemForNetwork(networkName),
        network: networkName,
        deployerSeed: opts.deployerSeed,
        delegatedSeed: opts.delegatedSeed,
        channelsApiKey: opts.channelsApiKey,
        includeDeployerSeed: opts.includeDeployerSeed ? true : undefined,
        overwriteExisting: Boolean(opts.force),
        createVault: opts.createVault,
      });

      if (!result.created_item) {
        const overwrittenFields = [
          ...(result.deployer_seed_stored ? ["deployer_seed"] : []),
          "delegated_seed",
          "channels_api_key",
        ].join(", ");
        process.stderr.write(
          `warning: item '${result.item}' already exists in vault '${result.vault}'. ` +
            `Overwriting fields: ${overwrittenFields}.\n`,
        );
      }

      if (!opts.json) {
        process.stderr.write("1Password wallet bootstrap complete.\n");
        process.stderr.write(
          `deployer_public_key=${result.deployer_public_key}\n` +
            `delegated_public_key=${result.delegated_public_key}\n`,
        );
        process.stderr.write(
          `refs: ${result.refs.deployer_seed_ref ?? "(not stored)"}, ${result.refs.delegated_seed_ref}, ${result.refs.channels_api_key_ref}\n`,
        );
        process.stderr.write("config snippet:\n");
        process.stderr.write(`${result.config_snippet}\n`);
      }

      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

  setup
    .command("keychain")
    .description("bootstrap macOS keychain secrets for wallet creation/signing")
    .option(
      "--service <name>",
      "macOS keychain service name (default: walleterm-testnet or walleterm-mainnet by network)",
    )
    .option("--network <name>", "network context (used for defaults)", "testnet")
    .option("--keychain <path>", "custom keychain path (defaults to the login keychain)")
    .option(
      "--deployer-seed <seed>",
      "existing deployer S... seed (if provided, it will be stored)",
    )
    .option("--delegated-seed <seed>", "existing delegated S... seed (defaults to generated)")
    .option(
      "--channels-api-key <key>",
      "channels API key (defaults to auto-generated on testnet/mainnet)",
    )
    .option(
      "--include-deployer-seed",
      "store deployer seed in the macOS keychain (default uses smart-account-kit deterministic deployer)",
      false,
    )
    .option("--force", "overwrite existing keychain entries", false)
    .option("--json", "print only json output", false)
    .action(async (opts: SetupKeychainOpts) => {
      const networkName = opts.network;
      const result = await setupMacOSKeychainForWallet({
        service: opts.service ?? defaultServiceForNetwork(networkName),
        network: networkName,
        keychain: opts.keychain,
        deployerSeed: opts.deployerSeed,
        delegatedSeed: opts.delegatedSeed,
        channelsApiKey: opts.channelsApiKey,
        includeDeployerSeed: opts.includeDeployerSeed ? true : undefined,
        overwriteExisting: Boolean(opts.force),
      });

      if (!opts.json) {
        process.stderr.write("macOS keychain wallet bootstrap complete.\n");
        process.stderr.write(
          `deployer_public_key=${result.deployer_public_key}\n` +
            `delegated_public_key=${result.delegated_public_key}\n`,
        );
        process.stderr.write(
          `refs: ${result.refs.deployer_seed_ref ?? "(not stored)"}, ${result.refs.delegated_seed_ref}, ${result.refs.channels_api_key_ref}\n`,
        );
        process.stderr.write("config snippet:\n");
        process.stderr.write(`${result.config_snippet}\n`);
      }

      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

  setup
    .command("ssh-agent")
    .description("discover or generate Ed25519 keys for SSH agent signing")
    .option("--backend <name>", "agent backend: system, 1password, or custom", "system")
    .option("--socket <path>", "explicit agent socket path (required for custom backend)")
    .option("--json", "print only json output", false)
    .option("--generate", "generate a new Ed25519 key in the backend", false)
    .option("--vault <name>", "1Password vault (for --generate with 1password backend)", "Private")
    .option(
      "--title <name>",
      "1Password item title (for --generate with 1password backend)",
      "walleterm-ed25519",
    )
    .option("--key-path <path>", "key file path (for --generate with system backend)")
    .action(async (opts: SetupSshAgentOpts) => {
      if (opts.generate) {
        const result = await generateSshAgentKey({
          backend: opts.backend as "1password" | "system",
          socketPath: opts.socket,
          vault: opts.vault,
          title: opts.title,
          keyPath: opts.keyPath,
        });

        if (!opts.json) {
          process.stderr.write(`SSH agent key generated (${result.backend}).\n`);
          process.stderr.write(`socket: ${result.socket_path}\n`);
          process.stderr.write(`stellar_address: ${result.key.stellar_address}\n`);
          process.stderr.write(`ref: ${result.key.ref}\n`);
          if (result.key_path) process.stderr.write(`key_path: ${result.key_path}\n`);
          if (result.agent_toml_path)
            process.stderr.write(`agent_toml: ${result.agent_toml_path}\n`);
          process.stderr.write("config snippet:\n");
          process.stderr.write(`${result.config_snippet}\n`);
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const result = await setupSshAgentForWallet({
          backend: opts.backend,
          socketPath: opts.socket,
        });

        if (!opts.json) {
          process.stderr.write(`SSH agent discovery complete (${result.backend}).\n`);
          process.stderr.write(`socket: ${result.socket_path}\n`);
          process.stderr.write(`found ${result.keys.length} Ed25519 key(s):\n`);
          for (const key of result.keys) {
            process.stderr.write(`  ${key.stellar_address} (${key.comment})\n`);
          }
          process.stderr.write("config snippet:\n");
          process.stderr.write(`${result.config_snippet}\n`);
        }

        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    });
}
