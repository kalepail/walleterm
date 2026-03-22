import { Command } from "commander";
import { registerWalletCreateCommand } from "./wallet-create-command.js";
import { registerWalletLookupCommand } from "./wallet-lookup-command.js";
import { registerWalletSignerCommands } from "./wallet-signer-commands.js";

export function registerWalletCommands(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("OpenZeppelin smart-account wallet management")
    .addHelpText(
      "after",
      [
        "",
        "Primary wallet flows:",
        "  walleterm wallet lookup --secret-ref op://Private/walleterm-testnet/delegated_seed",
        "  walleterm wallet lookup --secret-ref keychain://walleterm-testnet/delegated_seed",
        "  walleterm wallet create --wasm-hash <hash> --delegated-address G... --out ./deploy.tx.xdr",
        "  walleterm wallet signer add --account treasury --secret-ref <ref> --out ./add.bundle.json",
        "  walleterm wallet signer remove --account treasury --secret-ref <ref> --out ./remove.bundle.json",
      ].join("\n"),
    );

  registerWalletLookupCommand(wallet);
  registerWalletSignerCommands(wallet);
  registerWalletCreateCommand(wallet);
}
