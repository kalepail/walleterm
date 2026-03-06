import { describe, expect, it } from "vitest";
import { execa } from "execa";

const PROJECT_ROOT = "/Users/kalepail/Desktop/walleterm";

describe("walleterm help e2e", () => {
  it("shows only the primary top-level command surface", async () => {
    const result = await execa("bun", ["src/cli.ts", "--help"], {
      cwd: PROJECT_ROOT,
    });

    expect(result.stdout).toContain("review");
    expect(result.stdout).toContain("sign");
    expect(result.stdout).toContain("submit");
    expect(result.stdout).toContain("setup");
    expect(result.stdout).toContain("wallet");

    expect(result.stdout).not.toMatch(/\n\s+inspect\b/);
    expect(result.stdout).not.toMatch(/\n\s+can-sign\b/);
    expect(result.stdout).not.toMatch(/\n\s+keys\b/);
  });

  it("shows only the primary wallet command surface", async () => {
    const result = await execa("bun", ["src/cli.ts", "wallet", "--help"], {
      cwd: PROJECT_ROOT,
    });

    expect(result.stdout).toContain("lookup");
    expect(result.stdout).toContain("signer");
    expect(result.stdout).toContain("create");

    expect(result.stdout).not.toMatch(/\n\s+discover\b/);
    expect(result.stdout).not.toMatch(/\n\s+list-signers\b/);
    expect(result.stdout).not.toMatch(/\n\s+reconcile\b/);
    expect(result.stdout).not.toMatch(/\n\s+add-delegated-signer\b/);
    expect(result.stdout).not.toMatch(/\n\s+add-external-ed25519-signer\b/);
  });

  it("shows only the primary signer command surface", async () => {
    const result = await execa("bun", ["src/cli.ts", "wallet", "signer", "--help"], {
      cwd: PROJECT_ROOT,
    });

    expect(result.stdout).toContain("generate");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("remove");

    expect(result.stdout).not.toMatch(/\n\s+verify\b/);
  });
});
