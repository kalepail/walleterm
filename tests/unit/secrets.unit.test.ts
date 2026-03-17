import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/temp-dir.js";
import {
  SecretResolver,
  buildKeychainSecretRef,
  isSshAgentRef,
  parseKeychainSecretRef,
} from "../../src/secrets.js";

function makeExecutableScript(name: string, contents: string): { binPath: string; root: string } {
  const root = makeTempDir("walleterm-secrets-unit-");
  const binPath = join(root, name);
  writeFileSync(binPath, contents, "utf8");
  chmodSync(binPath, 0o755);
  return { binPath, root };
}

function makeOpScript(contents: string): { opBin: string; root: string } {
  const { binPath, root } = makeExecutableScript("op", contents);
  return { opBin: binPath, root };
}

function makeSecurityScript(contents: string): { securityBin: string; root: string } {
  const { binPath, root } = makeExecutableScript("security", contents);
  return { securityBin: binPath, root };
}

describe("secrets unit", () => {
  it("resolves and caches op:// refs", async () => {
    const countPath = join(makeTempDir("walleterm-secrets-count-"), "count.txt");
    writeFileSync(countPath, "0", "utf8");
    const { opBin } = makeOpScript(`#!/usr/bin/env node
const fs = require("node:fs");
const ref = process.argv[3];
const countPath = process.env.WALLETERM_COUNT_PATH;
const n = Number(fs.readFileSync(countPath, "utf8"));
fs.writeFileSync(countPath, String(n + 1), "utf8");
if (process.argv[2] === "read" && ref === "op://vault/item/field") {
  process.stdout.write("secret-value");
  process.exit(0);
}
process.exit(1);
`);

    process.env.WALLETERM_COUNT_PATH = countPath;
    const resolver = new SecretResolver(opBin);
    expect(await resolver.resolve("op://vault/item/field")).toBe("secret-value");
    expect(await resolver.resolve("op://vault/item/field")).toBe("secret-value");
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");
    delete process.env.WALLETERM_COUNT_PATH;
  });

  it("rejects non-op refs", async () => {
    const resolver = new SecretResolver("op");
    await expect(resolver.resolve("env://not-supported")).rejects.toThrow(
      /Supported schemes: keychain:\/\/, op:\/\//i,
    );
  });

  it("surfaces op read failures", async () => {
    const { opBin } = makeOpScript(`#!/usr/bin/env node
process.stderr.write("boom");
process.exit(1);
`);
    const resolver = new SecretResolver(opBin);
    await expect(resolver.resolve("op://vault/item/field")).rejects.toThrow(
      /Failed resolving 1Password ref/i,
    );
  });

  it("rejects empty resolved values", async () => {
    const { opBin } = makeOpScript(`#!/usr/bin/env node
if (process.argv[2] === "read") {
  process.stdout.write("   ");
  process.exit(0);
}
process.exit(1);
`);
    const resolver = new SecretResolver(opBin);
    await expect(resolver.resolve("op://vault/item/field")).rejects.toThrow(/empty value/i);
  });

  it("uses WALLETERM_OP_BIN when constructor arg is omitted", async () => {
    const { opBin } = makeOpScript(`#!/usr/bin/env node
if (process.argv[2] === "read" && process.argv[3] === "op://vault/item/field") {
  process.stdout.write("secret-from-env");
  process.exit(0);
}
process.exit(1);
`);
    const prev = process.env.WALLETERM_OP_BIN;
    process.env.WALLETERM_OP_BIN = opBin;
    try {
      const resolver = new SecretResolver();
      await expect(resolver.resolve("op://vault/item/field")).resolves.toBe("secret-from-env");
    } finally {
      if (prev === undefined) delete process.env.WALLETERM_OP_BIN;
      else process.env.WALLETERM_OP_BIN = prev;
    }
  });

  it("falls back to default op binary name when arg/env are unset", async () => {
    const prev = process.env.WALLETERM_OP_BIN;
    delete process.env.WALLETERM_OP_BIN;
    try {
      const resolver = new SecretResolver();
      await expect(resolver.resolve("env://unsupported")).rejects.toThrow(
        /Supported schemes: keychain:\/\/, op:\/\//i,
      );
    } finally {
      if (prev !== undefined) process.env.WALLETERM_OP_BIN = prev;
    }
  });

  it("resolves and caches keychain refs", async () => {
    const countPath = join(makeTempDir("walleterm-keychain-count-"), "count.txt");
    writeFileSync(countPath, "0", "utf8");
    const { securityBin } = makeSecurityScript(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const countPath = process.env.WALLETERM_COUNT_PATH;
const n = Number(fs.readFileSync(countPath, "utf8"));
fs.writeFileSync(countPath, String(n + 1), "utf8");
if (
  args[0] === "find-generic-password" &&
  args[1] === "-a" &&
  args[2] === "delegated_seed" &&
  args[3] === "-s" &&
  args[4] === "walleterm-testnet" &&
  args[5] === "-w"
) {
  process.stdout.write("seed-from-keychain");
  process.exit(0);
}
process.stderr.write(args.join(" "));
process.exit(1);
`);

    process.env.WALLETERM_COUNT_PATH = countPath;
    const resolver = new SecretResolver({ securityBin });
    const ref = "keychain://walleterm-testnet/delegated_seed";
    expect(await resolver.resolve(ref)).toBe("seed-from-keychain");
    expect(await resolver.resolve(ref)).toBe("seed-from-keychain");
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");
    delete process.env.WALLETERM_COUNT_PATH;
  });

  it("parses and formats keychain refs with optional keychain path", () => {
    const ref = buildKeychainSecretRef(
      "Walleterm Testnet",
      "delegated_seed",
      "/Users/example/Library/Keychains/login.keychain-db",
    );

    expect(ref).toBe(
      "keychain://Walleterm%20Testnet/delegated_seed?keychain=%2FUsers%2Fexample%2FLibrary%2FKeychains%2Flogin.keychain-db",
    );
    expect(parseKeychainSecretRef(ref)).toEqual({
      service: "Walleterm Testnet",
      account: "delegated_seed",
      keychain: "/Users/example/Library/Keychains/login.keychain-db",
    });
  });

  it("canUseMacOSKeychain returns false on non-macOS without explicit securityBin", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const resolver = new SecretResolver({});
      expect(resolver.isSupportedRef("keychain://svc/acct")).toBe(false);
      expect(resolver.supportedSchemes()).toEqual(["op"]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("MacOSKeychainSecretProvider.resolve with custom keychain path appends it to args", async () => {
    const { securityBin } = makeSecurityScript(`#!/usr/bin/env node
const args = process.argv.slice(2);
if (
  args[0] === "find-generic-password" &&
  args[1] === "-a" &&
  args[2] === "delegated_seed" &&
  args[3] === "-s" &&
  args[4] === "walleterm-testnet" &&
  args[5] === "-w" &&
  args[6] === "/custom/keychain.db"
) {
  process.stdout.write("secret-from-custom-keychain");
  process.exit(0);
}
process.stderr.write("unexpected args: " + args.join(" "));
process.exit(1);
`);

    const resolver = new SecretResolver({ securityBin });
    const ref = buildKeychainSecretRef(
      "walleterm-testnet",
      "delegated_seed",
      "/custom/keychain.db",
    );
    expect(await resolver.resolve(ref)).toBe("secret-from-custom-keychain");
  });

  it("MacOSKeychainSecretProvider.resolve surfaces exec failure", async () => {
    const { securityBin } = makeSecurityScript(`#!/usr/bin/env node
process.stderr.write("keychain-boom");
process.exit(1);
`);

    const resolver = new SecretResolver({ securityBin });
    await expect(resolver.resolve("keychain://walleterm-testnet/delegated_seed")).rejects.toThrow(
      /Failed resolving macOS keychain ref/i,
    );
  });

  it("MacOSKeychainSecretProvider.resolve rejects empty value", async () => {
    const { securityBin } = makeSecurityScript(`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "find-generic-password") {
  process.stdout.write("   ");
  process.exit(0);
}
process.exit(1);
`);

    const resolver = new SecretResolver({ securityBin });
    await expect(resolver.resolve("keychain://walleterm-testnet/delegated_seed")).rejects.toThrow(
      /empty value/i,
    );
  });

  it("SecretResolver.resolve rejects bare string without scheme", async () => {
    const resolver = new SecretResolver("op");
    await expect(resolver.resolve("just-a-string")).rejects.toThrow(
      /Unsupported secret_ref 'just-a-string'\. Expected a provider ref like/,
    );
  });

  it("isSshAgentRef identifies ssh-agent scheme refs", () => {
    expect(isSshAgentRef("ssh-agent://system/GABC...")).toBe(true);
    expect(isSshAgentRef("ssh-agent://1password/GABC...")).toBe(true);
    expect(isSshAgentRef("op://vault/item/field")).toBe(false);
    expect(isSshAgentRef("keychain://service/account")).toBe(false);
    expect(isSshAgentRef("not-a-ref")).toBe(false);
  });

  it("clearCache causes a second resolve to call the provider again", async () => {
    const countPath = join(makeTempDir("walleterm-secrets-clear-"), "count.txt");
    writeFileSync(countPath, "0", "utf8");
    const { opBin } = makeOpScript(`#!/usr/bin/env node
const fs = require("node:fs");
const ref = process.argv[3];
const countPath = process.env.WALLETERM_COUNT_PATH;
const n = Number(fs.readFileSync(countPath, "utf8"));
fs.writeFileSync(countPath, String(n + 1), "utf8");
if (process.argv[2] === "read" && ref === "op://vault/item/field") {
  process.stdout.write("secret-value");
  process.exit(0);
}
process.exit(1);
`);

    process.env.WALLETERM_COUNT_PATH = countPath;
    const resolver = new SecretResolver(opBin);
    expect(await resolver.resolve("op://vault/item/field")).toBe("secret-value");
    expect(readFileSync(countPath, "utf8").trim()).toBe("1");

    resolver.clearCache();
    expect(await resolver.resolve("op://vault/item/field")).toBe("secret-value");
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    delete process.env.WALLETERM_COUNT_PATH;
  });
});
