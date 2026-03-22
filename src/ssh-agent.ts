import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";

const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENT_FAILURE = 5;

export interface SshAgentRef {
  backend: string;
  stellarAddress: string;
  socketPath?: string;
}

export interface SshAgentIdentity {
  keyBlob: Buffer;
  comment: string;
  publicKey: Buffer;
}

function writeUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function writeString(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([writeUint32(bytes.length), bytes]);
}

function readUint32(buf: Buffer, offset: number): { value: number; offset: number } {
  return { value: buf.readUInt32BE(offset), offset: offset + 4 };
}

function readString(buf: Buffer, offset: number): { value: Buffer; offset: number } {
  const { value: len, offset: off1 } = readUint32(buf, offset);
  return { value: buf.subarray(off1, off1 + len), offset: off1 + len };
}

function buildRequestIdentities(): Buffer {
  const type = Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]);
  return Buffer.concat([writeUint32(type.length), type]);
}

function buildSignRequest(keyBlob: Buffer, data: Buffer, flags = 0): Buffer {
  const type = Buffer.from([SSH2_AGENTC_SIGN_REQUEST]);
  const content = Buffer.concat([
    type,
    writeString(keyBlob),
    writeString(data),
    writeUint32(flags),
  ]);
  return Buffer.concat([writeUint32(content.length), content]);
}

export function buildEd25519KeyBlob(pubkey: Buffer): Buffer {
  return Buffer.concat([writeString("ssh-ed25519"), writeString(pubkey)]);
}

async function agentRequest(socketPath: string, request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let expectedLength = -1;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error(`SSH agent request timed out (socket: ${socketPath})`));
      }
    }, 60_000);

    socket.on("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalLength += chunk.length;

      if (expectedLength < 0 && totalLength >= 4) {
        const combined = Buffer.concat(chunks);
        expectedLength = combined.readUInt32BE(0) + 4;
      }

      if (expectedLength > 0 && totalLength >= expectedLength) {
        /* v8 ignore start -- defensive guard against duplicate data events after resolution */
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          socket.destroy();
          const full = Buffer.concat(chunks);
          resolve(full.subarray(4, expectedLength));
        }
        /* v8 ignore stop */
      }
    });

    socket.on("error", (err) => {
      /* v8 ignore start -- defensive guard against error after close/data resolution */
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH agent connection failed (socket: ${socketPath}): ${err.message}`));
      }
      /* v8 ignore stop */
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`SSH agent connection closed prematurely (socket: ${socketPath})`));
      }
    });
  });
}

export function parseSshAgentRef(ref: string): SshAgentRef {
  if (!ref.startsWith("ssh-agent://")) {
    throw new Error(`Invalid SSH agent ref '${ref}': must start with ssh-agent://`);
  }

  const withoutScheme = ref.slice("ssh-agent://".length);
  const [pathPart, queryPart] = withoutScheme.split("?", 2) as [string, string | undefined];
  const segments = pathPart.split("/").filter((s) => s.length > 0);

  if (segments.length !== 2) {
    throw new Error(
      `Invalid SSH agent ref '${ref}': expected ssh-agent://<backend>/<stellar-address>[?socket=<path>]`,
    );
  }

  const [backend, stellarAddress] = segments as [string, string];
  const query = new URLSearchParams(queryPart ?? "");
  const socketPath = query.get("socket")?.trim() || undefined;

  return { backend: decodeURIComponent(backend), stellarAddress, socketPath };
}

export function buildSshAgentRef(
  backend: string,
  stellarAddress: string,
  socketPath?: string,
): string {
  const base = `ssh-agent://${encodeURIComponent(backend)}/${stellarAddress}`;
  if (!socketPath) return base;
  return `${base}?socket=${encodeURIComponent(socketPath)}`;
}

export function resolveSocketPath(backend: string, explicit?: string): string {
  if (explicit) return explicit;

  if (backend === "1password") {
    if (process.platform === "darwin") {
      return join(homedir(), "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");
    }
    return join(homedir(), ".1password/agent.sock");
  }

  if (backend === "system") {
    const sock = process.env.SSH_AUTH_SOCK;
    if (!sock) {
      throw new Error(
        "SSH_AUTH_SOCK is not set. Ensure an SSH agent is running or specify a socket path.",
      );
    }
    return sock;
  }

  if (backend === "custom") {
    throw new Error("Custom SSH agent backend requires an explicit socket path via ?socket=<path>");
  }

  throw new Error(
    `Unknown SSH agent backend '${backend}'. Use 'system', '1password', or 'custom'.`,
  );
}

function parseIdentitiesResponse(data: Buffer): SshAgentIdentity[] {
  if (data.length === 0) {
    throw new Error("Empty response from SSH agent");
  }

  if (data[0] === SSH_AGENT_FAILURE) {
    throw new Error("SSH agent returned failure for identity request");
  }

  if (data[0] !== SSH2_AGENT_IDENTITIES_ANSWER) {
    throw new Error(`Unexpected SSH agent response type: ${data[0]}`);
  }

  try {
    let offset = 1;
    const { value: nkeys, offset: off1 } = readUint32(data, offset);
    offset = off1;

    const identities: SshAgentIdentity[] = [];

    for (let i = 0; i < nkeys; i++) {
      const { value: keyBlob, offset: off2 } = readString(data, offset);
      offset = off2;
      const { value: commentBuf, offset: off3 } = readString(data, offset);
      offset = off3;

      try {
        let blobOffset = 0;
        const { value: algoName, offset: boff1 } = readString(keyBlob, blobOffset);
        blobOffset = boff1;

        if (algoName.toString() !== "ssh-ed25519") continue;

        const { value: pubkey } = readString(keyBlob, blobOffset);
        if (pubkey.length !== 32) continue;

        identities.push({
          keyBlob: Buffer.from(keyBlob),
          comment: commentBuf.toString(),
          publicKey: Buffer.from(pubkey),
        });
      } catch {
        continue;
      }
    }

    return identities;
  } catch (err) {
    /* v8 ignore start -- malformed frame errors in practice always throw Error objects */
    if (!(err instanceof Error)) {
      const message = String(err);
      throw new Error(`Malformed SSH agent identities response: ${message}`);
    }
    /* v8 ignore stop */
    throw new Error(`Malformed SSH agent identities response: ${err.message}`);
  }
}

function parseSignResponse(data: Buffer): Buffer {
  if (data.length === 0) {
    throw new Error("Empty response from SSH agent for sign request");
  }

  if (data[0] === SSH_AGENT_FAILURE) {
    throw new Error("SSH agent refused to sign (agent returned failure)");
  }

  if (data[0] !== SSH2_AGENT_SIGN_RESPONSE) {
    throw new Error(`Unexpected SSH agent sign response type: ${data[0]}`);
  }

  try {
    let offset = 1;
    const { value: sigBlob } = readString(data, offset);

    let blobOffset = 0;
    const { value: algo, offset: boff1 } = readString(sigBlob, blobOffset);
    blobOffset = boff1;
    const { value: rawSig } = readString(sigBlob, blobOffset);

    if (algo.toString() !== "ssh-ed25519") {
      throw new Error(`Unexpected signature algorithm: ${algo.toString()}`);
    }

    if (rawSig.length !== 64) {
      throw new Error(`Unexpected Ed25519 signature length: ${rawSig.length}`);
    }

    return Buffer.from(rawSig);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("Unexpected ")) {
      throw new Error(`Malformed SSH agent sign response: ${err.message}`);
    }
    /* v8 ignore next -- malformed frame errors in practice always throw Error objects */
    throw err;
  }
}

export async function listAgentIdentities(socketPath: string): Promise<SshAgentIdentity[]> {
  const request = buildRequestIdentities();
  const response = await agentRequest(socketPath, request);
  return parseIdentitiesResponse(response);
}

export async function findAgentIdentity(
  socketPath: string,
  stellarAddress: string,
): Promise<SshAgentIdentity | null> {
  if (!stellarAddress.startsWith("G") || stellarAddress.length !== 56) {
    throw new Error(`Invalid Stellar address for SSH agent lookup: ${stellarAddress}`);
  }

  const expectedPubkey = Buffer.from(StrKey.decodeEd25519PublicKey(stellarAddress));
  const identities = await listAgentIdentities(socketPath);

  for (const identity of identities) {
    if (identity.publicKey.equals(expectedPubkey)) {
      return identity;
    }
  }

  return null;
}

export async function agentSign(
  socketPath: string,
  keyBlob: Buffer,
  data: Buffer,
): Promise<{ signature: Buffer }> {
  const request = buildSignRequest(keyBlob, data);
  const response = await agentRequest(socketPath, request);
  const signature = parseSignResponse(response);
  return { signature };
}
