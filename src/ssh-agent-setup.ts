import { StrKey } from "@stellar/stellar-sdk";
import {
  buildSshAgentRef,
  listAgentIdentities,
  resolveSocketPath,
} from "./ssh-agent.js";

export interface SetupSshAgentOptions {
  backend: string;
  socketPath?: string;
}

export interface SshAgentKeyInfo {
  stellar_address: string;
  public_key_hex: string;
  comment: string;
  ref: string;
}

export interface SetupSshAgentResult {
  backend: string;
  socket_path: string;
  keys: SshAgentKeyInfo[];
  config_snippet: string;
}

export async function setupSshAgentForWallet(
  opts: SetupSshAgentOptions,
): Promise<SetupSshAgentResult> {
  const socketPath = resolveSocketPath(opts.backend, opts.socketPath);
  const identities = await listAgentIdentities(socketPath);

  if (identities.length === 0) {
    throw new Error(`No Ed25519 keys found in SSH agent at ${socketPath}`);
  }

  const keys: SshAgentKeyInfo[] = identities.map((identity) => {
    const stellarAddress = StrKey.encodeEd25519PublicKey(identity.publicKey);
    const publicKeyHex = identity.publicKey.toString("hex");
    const ref = buildSshAgentRef(opts.backend, stellarAddress, opts.socketPath);
    return {
      stellar_address: stellarAddress,
      public_key_hex: publicKeyHex,
      comment: identity.comment,
      ref,
    };
  });

  const snippetLines = keys.map((key, index) => {
    const prefix = index === 0 ? "" : "\n";
    return `${prefix}[[smart_accounts.<alias>.delegated_signers]]
name = "ssh-agent-${index}"
address = "${key.stellar_address}"
secret_ref = "${key.ref}"
enabled = true`;
  });

  return {
    backend: opts.backend,
    socket_path: socketPath,
    keys,
    config_snippet: snippetLines.join("\n"),
  };
}
