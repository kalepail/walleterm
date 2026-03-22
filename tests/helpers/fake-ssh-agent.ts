import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { makeTempDir } from "./temp-dir.js";

const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENT_FAILURE = 5;

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

function buildKeyBlob(pubkey: Buffer): Buffer {
  return Buffer.concat([writeString("ssh-ed25519"), writeString(pubkey)]);
}

function buildIdentitiesResponse(keypairs: Keypair[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
    writeUint32(keypairs.length),
  ];

  for (const kp of keypairs) {
    const keyBlob = buildKeyBlob(Buffer.from(kp.rawPublicKey()));
    const comment = `fake-key-${kp.publicKey().slice(0, 8)}`;
    parts.push(writeString(keyBlob), writeString(comment));
  }

  const body = Buffer.concat(parts);
  return Buffer.concat([writeUint32(body.length), body]);
}

function buildSignResponse(keypair: Keypair, data: Buffer): Buffer {
  const signature = keypair.sign(data);
  const sigBlob = Buffer.concat([writeString("ssh-ed25519"), writeString(Buffer.from(signature))]);

  const body = Buffer.concat([Buffer.from([SSH2_AGENT_SIGN_RESPONSE]), writeString(sigBlob)]);

  return Buffer.concat([writeUint32(body.length), body]);
}

function buildFailureResponse(): Buffer {
  const body = Buffer.from([SSH_AGENT_FAILURE]);
  return Buffer.concat([writeUint32(body.length), body]);
}

export interface FakeSshAgentFixture {
  server: Server;
  socketPath: string;
  keypair: Keypair;
  stellarAddress: string;
  publicKeyHex: string;
  cleanup: () => Promise<void>;
}

export async function makeFakeSshAgentFixture(keypair?: Keypair): Promise<FakeSshAgentFixture> {
  const kp = keypair ?? Keypair.random();
  const rootDir = makeTempDir("walleterm-fake-ssh-agent-");
  const socketPath = join(rootDir, "agent.sock");

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        const totalLen = 4 + msgLen;

        if (buffer.length < totalLen) break;

        const msgType = buffer[4];
        const msgBody = buffer.subarray(5, totalLen);
        buffer = buffer.subarray(totalLen);

        if (msgType === SSH2_AGENTC_REQUEST_IDENTITIES) {
          socket.write(buildIdentitiesResponse([kp]));
        } else if (msgType === SSH2_AGENTC_SIGN_REQUEST) {
          let offset = 0;
          const { offset: off1 } = readString(msgBody, offset);
          offset = off1;
          const { value: data } = readString(msgBody, offset);

          socket.write(buildSignResponse(kp, data));
        } else {
          socket.write(buildFailureResponse());
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve());
  });

  return {
    server,
    socketPath,
    keypair: kp,
    stellarAddress: kp.publicKey(),
    publicKeyHex: Buffer.from(kp.rawPublicKey()).toString("hex"),
    cleanup: async () => {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
