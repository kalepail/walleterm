import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { StrKey } from "@stellar/stellar-sdk";
import { buildSshAgentRef, listAgentIdentities, resolveSocketPath } from "./ssh-agent.js";

const execFileAsync = promisify(execFile);

function filteredEnv(): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SSH_AUTH_SOCK",
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  for (const [key, val] of Object.entries(process.env)) {
    if ((key.startsWith("OP_") || key.startsWith("WALLETERM_")) && val) env[key] = val;
  }
  return env;
}

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

export interface GenerateSshAgentKeyOptions {
  backend: "1password" | "system";
  socketPath?: string;
  // 1Password-specific
  opBin?: string;
  vault?: string;
  title?: string;
  agentTomlPath?: string;
  // System-specific
  keyPath?: string;
  sshKeygenBin?: string;
  sshAddBin?: string;
}

export interface GenerateSshAgentKeyResult {
  backend: string;
  socket_path: string;
  generated: true;
  key: SshAgentKeyInfo;
  config_snippet: string;
  // 1Password-specific
  op_vault?: string;
  op_title?: string;
  op_item_id?: string;
  agent_toml_path?: string;
  agent_toml_updated?: boolean;
  // System-specific
  key_path?: string;
  public_key_path?: string;
}

export function parseOpenSshEd25519PubKey(opensshLine: string): Buffer {
  const parts = opensshLine.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
    throw new Error("Not an ssh-ed25519 public key");
  }
  const blob = Buffer.from(parts[1]!, "base64");

  let offset = 0;
  const algoLen = blob.readUInt32BE(offset);
  offset += 4;
  const algo = blob.subarray(offset, offset + algoLen).toString();
  offset += algoLen;

  if (algo !== "ssh-ed25519") {
    throw new Error("Not an ssh-ed25519 public key");
  }

  const keyLen = blob.readUInt32BE(offset);
  offset += 4;
  const key = blob.subarray(offset, offset + keyLen);

  if (key.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 key, got ${key.length} bytes`);
  }

  return Buffer.from(key);
}

export function resolve1PasswordAgentTomlPath(): string {
  return join(homedir(), ".config", "1Password", "ssh", "agent.toml");
}

export function appendToAgentToml(tomlPath: string, title: string, vault: string): boolean {
  let existing = "";
  try {
    existing = readFileSync(tomlPath, "utf-8");
  } catch {
    // File doesn't exist yet, start empty
  }

  // Check if a matching block already exists
  const lines = existing.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "[[ssh-keys]]") {
      let blockItem: string | undefined;
      let blockVault: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!.trim();
        if (line === "[[ssh-keys]]" || line === "") break;
        const itemMatch = line.match(/^item\s*=\s*"(.+)"$/);
        if (itemMatch) blockItem = itemMatch[1];
        const vaultMatch = line.match(/^vault\s*=\s*"(.+)"$/);
        if (vaultMatch) blockVault = vaultMatch[1];
      }
      if (blockItem === title && blockVault === vault) {
        return false;
      }
    }
  }

  const block = `[[ssh-keys]]\nitem = "${title}"\nvault = "${vault}"\n`;
  const separator =
    existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  const content = existing + separator + block;

  mkdirSync(dirname(tomlPath), { recursive: true });
  writeFileSync(tomlPath, content, "utf-8");
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OpItemField {
  id: string;
  value?: string;
}

interface OpItemCreateResult {
  id: string;
  fields?: OpItemField[];
}

export async function generateSshAgentKey1Password(
  opts: GenerateSshAgentKeyOptions,
): Promise<GenerateSshAgentKeyResult> {
  const opBin = opts.opBin ?? process.env.WALLETERM_OP_BIN ?? "op";
  const vault = opts.vault ?? "Private";
  const title = opts.title ?? "walleterm-ed25519";

  const { stdout } = await execFileAsync(
    opBin,
    [
      "item",
      "create",
      "--category",
      "SSH Key",
      "--ssh-generate-key",
      "ed25519",
      "--title",
      title,
      "--vault",
      vault,
      "--format",
      "json",
    ],
    { maxBuffer: 1024 * 1024, env: filteredEnv() },
  );

  const parsed: OpItemCreateResult = JSON.parse(stdout);
  const pubKeyField = parsed.fields?.find((f) => f.id === "public_key");
  if (!pubKeyField?.value) {
    throw new Error("1Password item did not contain a public_key field");
  }

  const pubkey = parseOpenSshEd25519PubKey(pubKeyField.value);
  const itemId = parsed.id;

  const tomlPath = opts.agentTomlPath ?? resolve1PasswordAgentTomlPath();
  const tomlUpdated = appendToAgentToml(tomlPath, title, vault);

  const socketPath = resolveSocketPath("1password", opts.socketPath);

  // Poll for up to 5 seconds for the key to appear
  let foundComment = "";
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const identities = await listAgentIdentities(socketPath);
      const match = identities.find((id) => id.publicKey.equals(pubkey));
      if (match) {
        foundComment = match.comment;
        break;
      }
    } catch {
      // Agent may not be ready yet
    }
    if (attempt < maxAttempts - 1) {
      await sleep(500);
    }
  }

  if (!foundComment) {
    process.stderr.write(
      "Warning: key was created but not yet visible in the SSH agent. " +
        "The 1Password agent may need a moment to pick it up.\n",
    );
  }

  const stellarAddress = StrKey.encodeEd25519PublicKey(pubkey);
  const ref = buildSshAgentRef("1password", stellarAddress, opts.socketPath);
  const configSnippet = `[[smart_accounts.<alias>.delegated_signers]]\nname = "ssh-agent-generated"\naddress = "${stellarAddress}"\nsecret_ref = "${ref}"\nenabled = true`;

  return {
    backend: "1password",
    socket_path: socketPath,
    generated: true,
    key: {
      stellar_address: stellarAddress,
      public_key_hex: pubkey.toString("hex"),
      comment: foundComment,
      ref,
    },
    config_snippet: configSnippet,
    op_vault: vault,
    op_title: title,
    op_item_id: itemId,
    agent_toml_path: tomlPath,
    agent_toml_updated: tomlUpdated,
  };
}

export async function generateSshAgentKeySystem(
  opts: GenerateSshAgentKeyOptions,
): Promise<GenerateSshAgentKeyResult> {
  const keyPath = opts.keyPath ?? join(homedir(), ".ssh", "walleterm_ed25519");
  const pubKeyPath = keyPath + ".pub";

  if (existsSync(keyPath)) {
    throw new Error(`Key file already exists at ${keyPath}. Remove it or use --key-path.`);
  }

  mkdirSync(dirname(keyPath), { recursive: true });

  const sshKeygenBin = opts.sshKeygenBin ?? process.env.WALLETERM_SSH_KEYGEN_BIN ?? "ssh-keygen";
  const sshAddBin = opts.sshAddBin ?? process.env.WALLETERM_SSH_ADD_BIN ?? "ssh-add";

  await execFileAsync(sshKeygenBin, ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "walleterm"], {
    maxBuffer: 1024 * 1024,
    env: filteredEnv(),
  });

  const pubKeyLine = readFileSync(pubKeyPath, "utf-8");
  const pubkey = parseOpenSshEd25519PubKey(pubKeyLine);

  await execFileAsync(sshAddBin, [keyPath], {
    maxBuffer: 1024 * 1024,
    env: filteredEnv(),
  });

  const socketPath = resolveSocketPath("system", opts.socketPath);
  const identities = await listAgentIdentities(socketPath);
  const match = identities.find((id) => id.publicKey.equals(pubkey));
  if (!match) {
    throw new Error(
      `Key was generated at ${keyPath} and added via ssh-add, but it was not found in the SSH agent at ${socketPath}.`,
    );
  }

  const stellarAddress = StrKey.encodeEd25519PublicKey(pubkey);
  const ref = buildSshAgentRef("system", stellarAddress, opts.socketPath);
  const configSnippet = `[[smart_accounts.<alias>.delegated_signers]]\nname = "ssh-agent-generated"\naddress = "${stellarAddress}"\nsecret_ref = "${ref}"\nenabled = true`;

  return {
    backend: "system",
    socket_path: socketPath,
    generated: true,
    key: {
      stellar_address: stellarAddress,
      public_key_hex: pubkey.toString("hex"),
      comment: match.comment,
      ref,
    },
    config_snippet: configSnippet,
    key_path: keyPath,
    public_key_path: pubKeyPath,
  };
}

/* v8 ignore start -- CLI validates supported backends */
export async function generateSshAgentKey(
  opts: GenerateSshAgentKeyOptions,
): Promise<GenerateSshAgentKeyResult> {
  if (opts.backend === "1password") {
    return generateSshAgentKey1Password(opts);
  }
  if (opts.backend === "system") {
    return generateSshAgentKeySystem(opts);
  }
  throw new Error(
    `Key generation is not supported for backend '${opts.backend}'. Use '1password' or 'system'.`,
  );
}
/* v8 ignore stop */

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
