import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliInProcess } from "../helpers/run-cli.js";
import {
  makeFakeSshAgentFixture,
  type FakeSshAgentFixture,
} from "../helpers/fake-ssh-agent.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** Build an SSH agent that always returns zero identities. */
function makeEmptyAgent(): Promise<{ server: Server; socketPath: string; cleanup: () => Promise<void> }> {
  const rootDir = makeTempDir("walleterm-empty-ssh-agent-");
  const socketPath = join(rootDir, "agent.sock");

  const SSH2_AGENT_IDENTITIES_ANSWER = 12;

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        const totalLen = 4 + msgLen;
        if (buffer.length < totalLen) break;

        buffer = buffer.subarray(totalLen);

        // Always respond with zero identities
        const body = Buffer.alloc(5);
        body[0] = SSH2_AGENT_IDENTITIES_ANSWER;
        body.writeUInt32BE(0, 1); // nkeys = 0
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(body.length, 0);
        socket.write(Buffer.concat([lenBuf, body]));
      }
    });
  });

  return new Promise<{ server: Server; socketPath: string; cleanup: () => Promise<void> }>((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        server,
        socketPath,
        cleanup: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe("walleterm setup ssh-agent e2e", () => {
  it("discovers SSH agent keys and outputs JSON with --json flag", async () => {
    const fx: FakeSshAgentFixture = await makeFakeSshAgentFixture();
    try {
      const res = await runCliInProcess([
        "setup",
        "ssh-agent",
        "--backend",
        "custom",
        "--socket",
        fx.socketPath,
        "--json",
      ]);

      const out = JSON.parse(res.stdout);

      expect(out.backend).toBe("custom");
      expect(out.socket_path).toBe(fx.socketPath);
      expect(out.keys).toHaveLength(1);

      const key = out.keys[0];
      expect(key.stellar_address).toBe(fx.stellarAddress);
      expect(key.public_key_hex).toBe(fx.publicKeyHex);
      expect(key.comment).toMatch(/^fake-key-/);
      expect(key.ref).toContain("ssh-agent://");
      expect(key.ref).toContain(fx.stellarAddress);

      expect(out.config_snippet).toContain("delegated_signers");
      expect(out.config_snippet).toContain(fx.stellarAddress);
      expect(out.config_snippet).toContain("secret_ref");
    } finally {
      await fx.cleanup();
    }
  }, 15000);

  it("prints human-readable output to stderr without --json", async () => {
    const fx: FakeSshAgentFixture = await makeFakeSshAgentFixture();
    try {
      const res = await runCliInProcess([
        "setup",
        "ssh-agent",
        "--backend",
        "custom",
        "--socket",
        fx.socketPath,
      ]);

      // stderr should contain human-readable output
      expect(res.stderr).toContain("SSH agent discovery complete");
      expect(res.stderr).toContain("found 1 Ed25519 key(s)");
      expect(res.stderr).toContain(fx.stellarAddress);
      expect(res.stderr).toContain("config snippet");

      // stdout should still contain valid JSON
      const out = JSON.parse(res.stdout);
      expect(out.backend).toBe("custom");
      expect(out.keys).toHaveLength(1);
      expect(out.keys[0].stellar_address).toBe(fx.stellarAddress);
    } finally {
      await fx.cleanup();
    }
  }, 15000);

  it("throws an error when no Ed25519 keys are found", async () => {
    const empty = await makeEmptyAgent();
    try {
      await expect(
        runCliInProcess([
          "setup",
          "ssh-agent",
          "--backend",
          "custom",
          "--socket",
          empty.socketPath,
          "--json",
        ]),
      ).rejects.toThrow(/No Ed25519 keys found/);
    } finally {
      await empty.cleanup();
    }
  }, 15000);
});
