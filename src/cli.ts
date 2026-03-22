#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { registerChannelCommands } from "./cli/channel-commands.js";
import { registerPayCommand } from "./cli/pay-command.js";
import { registerSetupCommands } from "./cli/setup-commands.js";
import { registerSigningCommands } from "./cli/signing-commands.js";
import { registerWalletCommands } from "./cli/wallet-commands.js";

const program = new Command();
program.exitOverride();
program
  .name("walleterm")
  .description("OpenZeppelin smart-account interface for Stellar")
  .addHelpText(
    "after",
    [
      "",
      "Primary flows:",
      "  walleterm review --in ./unsigned.json",
      "  walleterm sign --in ./unsigned.json --out ./signed.json",
      "  walleterm submit --in ./signed.json --mode channels",
      "  walleterm wallet lookup --secret-ref op://Private/walleterm-testnet/delegated_seed",
      "  walleterm wallet lookup --secret-ref keychain://walleterm-testnet/delegated_seed",
      "  walleterm wallet create --wasm-hash <hash> --delegated-address G... --out ./deploy.tx.xdr",
      "  walleterm wallet signer add --account treasury --secret-ref <ref> --out ./add.bundle.json",
      "  walleterm pay https://api.example.com/resource --secret-ref op://Private/testnet/seed",
      "  walleterm pay https://api.example.com/resource --dry-run --format json",
    ].join("\n"),
  )
  .showHelpAfterError();

registerSigningCommands(program);
registerPayCommand(program);
registerChannelCommands(program);
registerSetupCommands(program);
registerWalletCommands(program);

export async function runCli(argv: string[]): Promise<void> {
  await program.parseAsync(argv).catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.WALLETERM_THROW_ON_CLI_ERROR === "1") {
      throw error instanceof Error ? error : new Error(message);
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  });
}

if (import.meta.main) {
  await runCli(process.argv);
}
