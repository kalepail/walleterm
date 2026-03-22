import { readFileSync, writeFileSync } from "node:fs";
import { xdr } from "@stellar/stellar-sdk";
import type { ParsedInput } from "./types.js";

function parseTxEnvelope(raw: string): xdr.TransactionEnvelope | null {
  try {
    return xdr.TransactionEnvelope.fromXDR(raw, "base64");
  } catch {
    return null;
  }
}

function parseAuthEntry(raw: string): xdr.SorobanAuthorizationEntry | null {
  try {
    return xdr.SorobanAuthorizationEntry.fromXDR(raw, "base64");
  } catch {
    return null;
  }
}

export function parseInputFile(path: string): ParsedInput {
  const content = readFileSync(path, "utf8").trim();

  const tx = parseTxEnvelope(content);
  if (tx) {
    return { kind: "tx", envelope: tx };
  }

  const auth = parseAuthEntry(content);
  if (auth) {
    return { kind: "auth", auth: [auth] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new Error(`Input '${path}' is neither base64 XDR nor JSON`);
  }

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new Error(`Input JSON in '${path}' must be an object`);
  }

  const obj = parsedJson as Record<string, unknown>;

  if (typeof obj.xdr === "string") {
    const txEnvelope = parseTxEnvelope(obj.xdr);
    if (txEnvelope) {
      return { kind: "tx", envelope: txEnvelope };
    }
    const entry = parseAuthEntry(obj.xdr);
    if (entry) {
      return { kind: "auth", auth: [entry] };
    }
    throw new Error("JSON field 'xdr' is not a recognized transaction/auth XDR");
  }

  if (Array.isArray(obj.auth)) {
    const authEntries = obj.auth.map((value, index) => {
      if (typeof value !== "string") {
        throw new Error(`bundle.auth[${index}] must be a base64 XDR string`);
      }
      const entry = parseAuthEntry(value);
      if (!entry) {
        throw new Error(`bundle.auth[${index}] is not a valid SorobanAuthorizationEntry XDR`);
      }
      return entry;
    });

    return {
      kind: "bundle",
      func: typeof obj.func === "string" ? obj.func : undefined,
      auth: authEntries,
    };
  }

  throw new Error("Unsupported input JSON format. Use {xdr} or {func,auth[]}.");
}

export function writeOutput(path: string, content: string): void {
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
