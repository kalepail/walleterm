import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeFakeSshAgentFixture } from "../helpers/fake-ssh-agent.js";
import {
  parseSshAgentRef,
  buildSshAgentRef,
  resolveSocketPath,
  buildEd25519KeyBlob,
  listAgentIdentities,
  findAgentIdentity,
  agentSign,
} from "../../src/ssh-agent.js";

/* ------------------------------------------------------------------ */
/*  Helpers for custom mock servers                                    */
/* ------------------------------------------------------------------ */

function writeUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function writeString(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([writeUint32(bytes.length), bytes]);
}

/**
 * Creates a Unix-socket server that replies with a fixed payload to every
 * incoming request. Returns the socket path and a cleanup function.
 */
async function makeFixedReplyServer(
  replyPayload: Buffer,
): Promise<{ socketPath: string; server: Server; cleanup: () => Promise<void> }> {
  const root = makeTempDir("walleterm-ssh-agent-mock-");
  const socketPath = join(root, "agent.sock");

  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.write(replyPayload);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    server,
    cleanup: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Frame a body buffer as a length-prefixed SSH agent response.
 */
function frameResponse(body: Buffer): Buffer {
  return Buffer.concat([writeUint32(body.length), body]);
}

/* ------------------------------------------------------------------ */
/*  Fixture bookkeeping                                                */
/* ------------------------------------------------------------------ */

const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of pendingCleanups.splice(0)) {
    await fn();
  }
});

/* ------------------------------------------------------------------ */
/*  parseSshAgentRef                                                   */
/* ------------------------------------------------------------------ */

describe("parseSshAgentRef", () => {
  it("parses a valid ref without socket", () => {
    const addr = Keypair.random().publicKey();
    const ref = `ssh-agent://system/${addr}`;
    const result = parseSshAgentRef(ref);
    expect(result).toEqual({ backend: "system", stellarAddress: addr, socketPath: undefined });
  });

  it("parses a valid ref with socket query param", () => {
    const addr = Keypair.random().publicKey();
    const ref = `ssh-agent://1password/${addr}?socket=%2Ftmp%2Fagent.sock`;
    const result = parseSshAgentRef(ref);
    expect(result).toEqual({
      backend: "1password",
      stellarAddress: addr,
      socketPath: "/tmp/agent.sock",
    });
  });

  it("decodes URI-encoded backend", () => {
    const addr = Keypair.random().publicKey();
    const ref = `ssh-agent://${encodeURIComponent("my backend")}/${addr}`;
    const result = parseSshAgentRef(ref);
    expect(result.backend).toBe("my backend");
  });

  it("throws when scheme is missing", () => {
    expect(() => parseSshAgentRef("not-ssh://system/GABC")).toThrow(
      /must start with ssh-agent:\/\//,
    );
  });

  it("throws when there are too few segments", () => {
    expect(() => parseSshAgentRef("ssh-agent://system")).toThrow(
      /expected ssh-agent:\/\/<backend>\/<stellar-address>/,
    );
  });

  it("throws when there are too many segments", () => {
    expect(() => parseSshAgentRef("ssh-agent://a/b/c")).toThrow(
      /expected ssh-agent:\/\/<backend>\/<stellar-address>/,
    );
  });

  it("treats empty socket query param as undefined", () => {
    const addr = Keypair.random().publicKey();
    const ref = `ssh-agent://system/${addr}?socket=`;
    const result = parseSshAgentRef(ref);
    expect(result.socketPath).toBeUndefined();
  });

  it("treats whitespace-only socket query param as undefined", () => {
    const addr = Keypair.random().publicKey();
    const ref = `ssh-agent://system/${addr}?socket=%20%20`;
    const result = parseSshAgentRef(ref);
    expect(result.socketPath).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  buildSshAgentRef                                                   */
/* ------------------------------------------------------------------ */

describe("buildSshAgentRef", () => {
  it("builds a ref without socket", () => {
    const addr = Keypair.random().publicKey();
    const ref = buildSshAgentRef("system", addr);
    expect(ref).toBe(`ssh-agent://system/${addr}`);
  });

  it("builds a ref with a URL-encoded socket path", () => {
    const addr = Keypair.random().publicKey();
    const ref = buildSshAgentRef("1password", addr, "/path with spaces/agent.sock");
    expect(ref).toBe(
      `ssh-agent://1password/${addr}?socket=${encodeURIComponent("/path with spaces/agent.sock")}`,
    );
  });

  it("URI-encodes the backend", () => {
    const addr = Keypair.random().publicKey();
    const ref = buildSshAgentRef("my backend", addr);
    expect(ref).toBe(`ssh-agent://my%20backend/${addr}`);
  });

  it("round-trips through parseSshAgentRef", () => {
    const addr = Keypair.random().publicKey();
    const socket = "/tmp/agent.sock";
    const ref = buildSshAgentRef("1password", addr, socket);
    const parsed = parseSshAgentRef(ref);
    expect(parsed).toEqual({
      backend: "1password",
      stellarAddress: addr,
      socketPath: socket,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  resolveSocketPath                                                  */
/* ------------------------------------------------------------------ */

describe("resolveSocketPath", () => {
  it("returns explicit socket when provided, regardless of backend", () => {
    expect(resolveSocketPath("system", "/explicit/path")).toBe("/explicit/path");
    expect(resolveSocketPath("1password", "/explicit/path")).toBe("/explicit/path");
    expect(resolveSocketPath("custom", "/explicit/path")).toBe("/explicit/path");
    expect(resolveSocketPath("unknown", "/explicit/path")).toBe("/explicit/path");
  });

  it("reads SSH_AUTH_SOCK for system backend", () => {
    const prev = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/system-agent.sock";
    try {
      expect(resolveSocketPath("system")).toBe("/tmp/system-agent.sock");
    } finally {
      if (prev === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prev;
    }
  });

  it("throws when system backend and SSH_AUTH_SOCK is not set", () => {
    const prev = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      expect(() => resolveSocketPath("system")).toThrow(/SSH_AUTH_SOCK is not set/);
    } finally {
      if (prev !== undefined) process.env.SSH_AUTH_SOCK = prev;
    }
  });

  it("returns well-known darwin path for 1password on macOS", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const expected = join(
        homedir(),
        "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
      );
      expect(resolveSocketPath("1password")).toBe(expected);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("returns well-known linux path for 1password on non-darwin", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const expected = join(homedir(), ".1password/agent.sock");
      expect(resolveSocketPath("1password")).toBe(expected);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("throws for custom backend without explicit socket", () => {
    expect(() => resolveSocketPath("custom")).toThrow(
      /Custom SSH agent backend requires an explicit socket path/,
    );
  });

  it("throws for unknown backend without explicit socket", () => {
    expect(() => resolveSocketPath("foobar")).toThrow(
      /Unknown SSH agent backend 'foobar'/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  buildEd25519KeyBlob                                                */
/* ------------------------------------------------------------------ */

describe("buildEd25519KeyBlob", () => {
  it("produces correct wire format: string('ssh-ed25519') + string(pubkey)", () => {
    const kp = Keypair.random();
    const pubkey = Buffer.from(kp.rawPublicKey());
    const blob = buildEd25519KeyBlob(pubkey);

    // Parse back: first string should be "ssh-ed25519"
    let offset = 0;
    const algoLen = blob.readUInt32BE(offset);
    offset += 4;
    const algo = blob.subarray(offset, offset + algoLen).toString();
    offset += algoLen;
    expect(algo).toBe("ssh-ed25519");

    // Second string should be the raw 32-byte public key
    const keyLen = blob.readUInt32BE(offset);
    offset += 4;
    const key = blob.subarray(offset, offset + keyLen);
    offset += keyLen;
    expect(key.length).toBe(32);
    expect(Buffer.compare(key, pubkey)).toBe(0);

    // No trailing data
    expect(offset).toBe(blob.length);
  });
});

/* ------------------------------------------------------------------ */
/*  listAgentIdentities                                                */
/* ------------------------------------------------------------------ */

describe("listAgentIdentities", () => {
  it("returns Ed25519 keys from the agent", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    const identities = await listAgentIdentities(fixture.socketPath);
    expect(identities).toHaveLength(1);
    expect(identities[0]!.publicKey.length).toBe(32);
    expect(identities[0]!.comment).toContain("fake-key-");

    const expectedPubkey = Buffer.from(fixture.keypair.rawPublicKey());
    expect(identities[0]!.publicKey.equals(expectedPubkey)).toBe(true);
  });

  it("filters out non-Ed25519 keys", async () => {
    // Build a response containing one RSA key and one Ed25519 key
    const ed25519Kp = Keypair.random();
    const ed25519Blob = Buffer.concat([
      writeString("ssh-ed25519"),
      writeString(Buffer.from(ed25519Kp.rawPublicKey())),
    ]);
    const rsaBlob = Buffer.concat([
      writeString("ssh-rsa"),
      writeString(Buffer.alloc(256, 0x42)), // fake RSA public key data
    ]);

    const SSH2_AGENT_IDENTITIES_ANSWER = 12;
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      writeUint32(2), // 2 keys
      writeString(rsaBlob),
      writeString("rsa-key-comment"),
      writeString(ed25519Blob),
      writeString("ed25519-key-comment"),
    ]);

    const mock = await makeFixedReplyServer(frameResponse(body));
    pendingCleanups.push(mock.cleanup);

    const identities = await listAgentIdentities(mock.socketPath);
    expect(identities).toHaveLength(1);
    expect(identities[0]!.comment).toBe("ed25519-key-comment");
  });

  it("skips keys with wrong pubkey length", async () => {
    // Ed25519 algo name but 16-byte key instead of 32
    const shortKeyBlob = Buffer.concat([
      writeString("ssh-ed25519"),
      writeString(Buffer.alloc(16, 0xaa)),
    ]);

    const SSH2_AGENT_IDENTITIES_ANSWER = 12;
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      writeUint32(1),
      writeString(shortKeyBlob),
      writeString("short-key"),
    ]);

    const mock = await makeFixedReplyServer(frameResponse(body));
    pendingCleanups.push(mock.cleanup);

    const identities = await listAgentIdentities(mock.socketPath);
    expect(identities).toHaveLength(0);
  });

  it("skips keys with malformed blobs (parse error in blob)", async () => {
    // A truncated key blob that will cause readString to fail
    const truncatedBlob = Buffer.alloc(2, 0xff);

    const SSH2_AGENT_IDENTITIES_ANSWER = 12;
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      writeUint32(1),
      writeString(truncatedBlob),
      writeString("bad-blob-key"),
    ]);

    const mock = await makeFixedReplyServer(frameResponse(body));
    pendingCleanups.push(mock.cleanup);

    const identities = await listAgentIdentities(mock.socketPath);
    expect(identities).toHaveLength(0);
  });

  it("throws on empty response", async () => {
    const mock = await makeFixedReplyServer(frameResponse(Buffer.alloc(0)));
    pendingCleanups.push(mock.cleanup);

    await expect(listAgentIdentities(mock.socketPath)).rejects.toThrow(
      /Empty response from SSH agent/,
    );
  });

  it("throws on SSH_AGENT_FAILURE response", async () => {
    const SSH_AGENT_FAILURE = 5;
    const mock = await makeFixedReplyServer(frameResponse(Buffer.from([SSH_AGENT_FAILURE])));
    pendingCleanups.push(mock.cleanup);

    await expect(listAgentIdentities(mock.socketPath)).rejects.toThrow(
      /SSH agent returned failure for identity request/,
    );
  });

  it("throws on unexpected response type", async () => {
    const mock = await makeFixedReplyServer(frameResponse(Buffer.from([99])));
    pendingCleanups.push(mock.cleanup);

    await expect(listAgentIdentities(mock.socketPath)).rejects.toThrow(
      /Unexpected SSH agent response type: 99/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  findAgentIdentity                                                  */
/* ------------------------------------------------------------------ */

describe("findAgentIdentity", () => {
  it("finds a matching key by Stellar address", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    const identity = await findAgentIdentity(fixture.socketPath, fixture.stellarAddress);
    expect(identity).not.toBeNull();
    expect(identity!.publicKey.equals(Buffer.from(fixture.keypair.rawPublicKey()))).toBe(true);
  });

  it("returns null when no match", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    const other = Keypair.random().publicKey();
    const identity = await findAgentIdentity(fixture.socketPath, other);
    expect(identity).toBeNull();
  });

  it("throws on invalid Stellar address (wrong prefix)", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    await expect(findAgentIdentity(fixture.socketPath, "SABC")).rejects.toThrow(
      /Invalid Stellar address for SSH agent lookup/,
    );
  });

  it("throws on invalid Stellar address (wrong length)", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    await expect(findAgentIdentity(fixture.socketPath, "GABCDEF")).rejects.toThrow(
      /Invalid Stellar address for SSH agent lookup/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  agentSign                                                          */
/* ------------------------------------------------------------------ */

describe("agentSign", () => {
  it("signs data and produces a valid Ed25519 signature", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    const data = Buffer.from("hello world");
    const keyBlob = buildEd25519KeyBlob(Buffer.from(fixture.keypair.rawPublicKey()));
    const { signature } = await agentSign(fixture.socketPath, keyBlob, data);

    expect(signature.length).toBe(64);
    // Verify against the known keypair
    expect(fixture.keypair.verify(data, signature)).toBe(true);
  });

  it("signs different data and signatures differ", async () => {
    const fixture = await makeFakeSshAgentFixture();
    pendingCleanups.push(fixture.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(fixture.keypair.rawPublicKey()));
    const { signature: sig1 } = await agentSign(fixture.socketPath, keyBlob, Buffer.from("aaa"));
    const { signature: sig2 } = await agentSign(fixture.socketPath, keyBlob, Buffer.from("bbb"));

    expect(Buffer.compare(sig1, sig2)).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Sign response error paths                                          */
/* ------------------------------------------------------------------ */

describe("agentSign error paths", () => {
  it("throws on empty sign response", async () => {
    const mock = await makeFixedReplyServer(frameResponse(Buffer.alloc(0)));
    pendingCleanups.push(mock.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(Keypair.random().rawPublicKey()));
    await expect(agentSign(mock.socketPath, keyBlob, Buffer.from("data"))).rejects.toThrow(
      /Empty response from SSH agent for sign request/,
    );
  });

  it("throws on SSH_AGENT_FAILURE for sign", async () => {
    const SSH_AGENT_FAILURE = 5;
    const mock = await makeFixedReplyServer(frameResponse(Buffer.from([SSH_AGENT_FAILURE])));
    pendingCleanups.push(mock.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(Keypair.random().rawPublicKey()));
    await expect(agentSign(mock.socketPath, keyBlob, Buffer.from("data"))).rejects.toThrow(
      /SSH agent refused to sign/,
    );
  });

  it("throws on unexpected sign response type", async () => {
    const mock = await makeFixedReplyServer(frameResponse(Buffer.from([77])));
    pendingCleanups.push(mock.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(Keypair.random().rawPublicKey()));
    await expect(agentSign(mock.socketPath, keyBlob, Buffer.from("data"))).rejects.toThrow(
      /Unexpected SSH agent sign response type: 77/,
    );
  });

  it("throws on wrong signature algorithm", async () => {
    const SSH2_AGENT_SIGN_RESPONSE = 14;
    const sigBlob = Buffer.concat([
      writeString("ssh-rsa"),
      writeString(Buffer.alloc(64, 0xab)),
    ]);
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_SIGN_RESPONSE]),
      writeString(sigBlob),
    ]);

    const mock = await makeFixedReplyServer(frameResponse(body));
    pendingCleanups.push(mock.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(Keypair.random().rawPublicKey()));
    await expect(agentSign(mock.socketPath, keyBlob, Buffer.from("data"))).rejects.toThrow(
      /Unexpected signature algorithm: ssh-rsa/,
    );
  });

  it("throws on wrong signature length", async () => {
    const SSH2_AGENT_SIGN_RESPONSE = 14;
    const sigBlob = Buffer.concat([
      writeString("ssh-ed25519"),
      writeString(Buffer.alloc(32, 0xcd)), // 32 instead of 64
    ]);
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_SIGN_RESPONSE]),
      writeString(sigBlob),
    ]);

    const mock = await makeFixedReplyServer(frameResponse(body));
    pendingCleanups.push(mock.cleanup);

    const keyBlob = buildEd25519KeyBlob(Buffer.from(Keypair.random().rawPublicKey()));
    await expect(agentSign(mock.socketPath, keyBlob, Buffer.from("data"))).rejects.toThrow(
      /Unexpected Ed25519 signature length: 32/,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Chunked data reception                                             */
/* ------------------------------------------------------------------ */

describe("chunked data reception", () => {
  it("handles response arriving in tiny chunks (< 4 bytes each)", async () => {
    // Build a valid identities response with zero keys
    const SSH2_AGENT_IDENTITIES_ANSWER = 12;
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      writeUint32(0), // 0 keys
    ]);
    const fullResponse = frameResponse(body);

    const root = makeTempDir("walleterm-ssh-agent-chunked-");
    const socketPath = join(root, "agent.sock");

    const server = createServer((socket) => {
      socket.on("data", () => {
        // Send the response one byte at a time, which forces:
        // - First few data events: totalLength < 4, so expectedLength stays -1
        //   and the (expectedLength > 0) check is false
        // - After 4 bytes: expectedLength is set, so (expectedLength < 0) is false
        //   on subsequent chunks
        let offset = 0;
        const sendNext = (): void => {
          if (offset >= fullResponse.length) return;
          socket.write(fullResponse.subarray(offset, offset + 1), () => {
            offset += 1;
            // Use setImmediate to ensure each byte is a separate data event
            setImmediate(sendNext);
          });
        };
        sendNext();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });
    pendingCleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

    const identities = await listAgentIdentities(socketPath);
    expect(identities).toHaveLength(0);
  });

  it("handles response where first chunk has exactly length header", async () => {
    // Build a valid identities response with zero keys
    const SSH2_AGENT_IDENTITIES_ANSWER = 12;
    const body = Buffer.concat([
      Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
      writeUint32(0),
    ]);
    const fullResponse = frameResponse(body);

    const root = makeTempDir("walleterm-ssh-agent-split-");
    const socketPath = join(root, "agent.sock");

    const server = createServer((socket) => {
      socket.on("data", () => {
        // Send length header first, then body in a separate write
        socket.write(fullResponse.subarray(0, 4), () => {
          setImmediate(() => {
            socket.write(fullResponse.subarray(4));
          });
        });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });
    pendingCleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

    const identities = await listAgentIdentities(socketPath);
    expect(identities).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Guard branch coverage: already-resolved paths                      */
/* ------------------------------------------------------------------ */

describe("already-resolved guard branches", () => {
  it("ignores timeout after successful resolution", async () => {
    // Override both setTimeout (to use a short delay) and clearTimeout
    // (to be a no-op) so the timeout callback actually fires after
    // the request has already resolved, exercising the `!resolved`
    // false branch in the timeout handler.
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
      return origSetTimeout(fn, 20, ...args);
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = (() => {
      // intentional no-op so the timeout fires even after clearTimeout is called
    }) as unknown as typeof globalThis.clearTimeout;

    try {
      const fixture = await makeFakeSshAgentFixture();
      pendingCleanups.push(fixture.cleanup);

      const identities = await listAgentIdentities(fixture.socketPath);
      expect(identities).toHaveLength(1);

      // Wait for the shortened timeout to fire. The callback will see
      // resolved=true and skip the body.
      await new Promise((resolve) => origSetTimeout(resolve, 80));
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Connection error paths                                             */
/* ------------------------------------------------------------------ */

describe("connection errors", () => {
  it("rejects when socket path does not exist", async () => {
    const noSuchPath = join(makeTempDir("walleterm-no-sock-"), "nonexistent.sock");
    await expect(listAgentIdentities(noSuchPath)).rejects.toThrow(
      /SSH agent connection failed/,
    );
  });

  it("rejects when the server closes after receiving data (premature close)", async () => {
    const root = makeTempDir("walleterm-ssh-agent-close-");
    const socketPath = join(root, "agent.sock");

    const server = createServer((socket) => {
      // Wait for data to arrive (the write succeeds), then close cleanly
      // without sending a response. This triggers the 'close' handler
      // on the client side while `resolved` is still false.
      socket.on("data", () => {
        socket.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });
    pendingCleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

    await expect(listAgentIdentities(socketPath)).rejects.toThrow(
      /SSH agent connection closed prematurely/,
    );
  });

  it("times out when agent never responds", async () => {
    vi.useFakeTimers();

    const root = makeTempDir("walleterm-ssh-agent-timeout-");
    const socketPath = join(root, "agent.sock");

    // Server accepts data but never responds
    const server = createServer((_socket) => {
      // intentionally empty -- hold the connection open
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });
    pendingCleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

    // Attach a catch handler immediately to prevent unhandled rejection
    let caughtError: Error | undefined;
    const promise = listAgentIdentities(socketPath).catch((err: Error) => {
      caughtError = err;
    });

    // Advance past the 60-second timeout
    await vi.advanceTimersByTimeAsync(61_000);

    await promise;
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/SSH agent request timed out/);

    vi.useRealTimers();
  });
});
