import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { basicNodeSigner, type SignAuthEntry } from "@stellar/stellar-sdk/contract";
import { isSshAgentRef, type SecretResolver } from "./secrets.js";
import { agentSign, findAgentIdentity, parseSshAgentRef, resolveSocketPath } from "./ssh-agent.js";

export interface Signer {
  publicKey(): string;
  rawPublicKey(): Buffer;
  signatureHint(): Buffer;
  sign(data: Buffer): Promise<Buffer>;
  signDecorated(data: Buffer): Promise<xdr.DecoratedSignature>;
  signTransaction(tx: { hash(): Buffer; signatures: xdr.DecoratedSignature[] }): Promise<void>;
}

export interface AuthEntrySigner {
  address: string;
  signAuthEntry: SignAuthEntry;
}

export interface PaymentSigner extends Signer {
  authEntrySigner(networkPassphrase: string): AuthEntrySigner;
}

export interface MppPaymentSigner extends Signer {
  secretSeed(): string;
}

export function isMppPaymentSigner(signer: Signer): signer is MppPaymentSigner {
  return "secretSeed" in signer && typeof signer.secretSeed === "function";
}

export class KeypairSigner implements PaymentSigner, MppPaymentSigner {
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

  authEntrySigner(networkPassphrase: string): AuthEntrySigner {
    const { signAuthEntry } = basicNodeSigner(this.keypair, networkPassphrase);
    return { address: this.publicKey(), signAuthEntry };
  }

  secretSeed(): string {
    return this.keypair.secret();
  }
}

export class SshAgentSigner implements PaymentSigner {
  private readonly stellarPublicKey: string;
  private readonly rawPubKey: Buffer;
  private readonly keyBlob: Buffer;
  private readonly socketPath: string;

  constructor(stellarPublicKey: string, rawPubKey: Buffer, keyBlob: Buffer, socketPath: string) {
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

  authEntrySigner(_networkPassphrase: string): AuthEntrySigner {
    const address = this.publicKey();
    return {
      address,
      signAuthEntry: async (authEntry: string) => {
        const data = hash(Buffer.from(authEntry, "base64"));
        const signature = await this.sign(data);
        return { signedAuthEntry: signature.toString("base64"), signerAddress: address };
      },
    };
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

export async function resolvePaymentSigner(
  ref: string,
  resolver: SecretResolver,
  invalidSecretMessage = "secret-ref must resolve to a valid Stellar secret seed (S...)",
): Promise<PaymentSigner> {
  if (isSshAgentRef(ref)) {
    return createSshAgentSigner(ref);
  }

  const secret = await resolver.resolve(ref);
  try {
    return new KeypairSigner(Keypair.fromSecret(secret));
  } catch {
    throw new Error(invalidSecretMessage);
  }
}
