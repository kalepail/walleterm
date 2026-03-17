import { type Keypair, xdr } from "@stellar/stellar-sdk";
import {
  agentSign,
  findAgentIdentity,
  parseSshAgentRef,
  resolveSocketPath,
} from "./ssh-agent.js";

export interface Signer {
  publicKey(): string;
  rawPublicKey(): Buffer;
  signatureHint(): Buffer;
  sign(data: Buffer): Promise<Buffer>;
  signDecorated(data: Buffer): Promise<xdr.DecoratedSignature>;
  signTransaction(tx: { hash(): Buffer; signatures: xdr.DecoratedSignature[] }): Promise<void>;
}

export class KeypairSigner implements Signer {
  private readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  rawPublicKey(): Buffer {
    return Buffer.from(this.keypair.rawPublicKey());
  }

  signatureHint(): Buffer {
    const raw = this.rawPublicKey();
    return raw.subarray(raw.length - 4);
  }

  async sign(data: Buffer): Promise<Buffer> {
    return Buffer.from(this.keypair.sign(data));
  }

  async signDecorated(data: Buffer): Promise<xdr.DecoratedSignature> {
    const signature = await this.sign(data);
    return new xdr.DecoratedSignature({ hint: this.signatureHint(), signature });
  }

  async signTransaction(tx: {
    hash(): Buffer;
    signatures: xdr.DecoratedSignature[];
  }): Promise<void> {
    const decorated = await this.signDecorated(tx.hash());
    tx.signatures.push(decorated);
  }
}

export class SshAgentSigner implements Signer {
  private readonly stellarPublicKey: string;
  private readonly rawPubKey: Buffer;
  private readonly keyBlob: Buffer;
  private readonly socketPath: string;

  constructor(
    stellarPublicKey: string,
    rawPubKey: Buffer,
    keyBlob: Buffer,
    socketPath: string,
  ) {
    this.stellarPublicKey = stellarPublicKey;
    this.rawPubKey = rawPubKey;
    this.keyBlob = keyBlob;
    this.socketPath = socketPath;
  }

  publicKey(): string {
    return this.stellarPublicKey;
  }

  rawPublicKey(): Buffer {
    return this.rawPubKey;
  }

  signatureHint(): Buffer {
    return this.rawPubKey.subarray(this.rawPubKey.length - 4);
  }

  async sign(data: Buffer): Promise<Buffer> {
    const { signature } = await agentSign(this.socketPath, this.keyBlob, data);
    return signature;
  }

  async signDecorated(data: Buffer): Promise<xdr.DecoratedSignature> {
    const signature = await this.sign(data);
    return new xdr.DecoratedSignature({ hint: this.signatureHint(), signature });
  }

  async signTransaction(tx: {
    hash(): Buffer;
    signatures: xdr.DecoratedSignature[];
  }): Promise<void> {
    const decorated = await this.signDecorated(tx.hash());
    tx.signatures.push(decorated);
  }
}

export async function createSshAgentSigner(ref: string): Promise<SshAgentSigner> {
  const parsed = parseSshAgentRef(ref);
  const socketPath = resolveSocketPath(parsed.backend, parsed.socketPath);
  const identity = await findAgentIdentity(socketPath, parsed.stellarAddress);

  if (!identity) {
    throw new Error(
      `No Ed25519 key matching ${parsed.stellarAddress} found in SSH agent (socket: ${socketPath})`,
    );
  }

  return new SshAgentSigner(
    parsed.stellarAddress,
    identity.publicKey,
    identity.keyBlob,
    socketPath,
  );
}
