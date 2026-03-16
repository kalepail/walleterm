# Walleterm Security Remediation Plan

**Date:** 2026-03-16
**Scope:** Full codebase security audit (6-agent) — secrets/credentials, wallet/crypto, CLI input/config, test coverage, dependencies/supply chain

This document supersedes `docs/security-audit.md` as the canonical security tracking document.

---

## Overall Assessment

The codebase has a **strong security posture** for a CLI tool. No critical vulnerabilities were found. The architecture makes excellent design choices documented in [Positive Security Practices](#positive-security-practices).

---

## Remediated Findings

### H1: Weak Nonce Generation — FIXED

- **File:** `src/core.ts`
- **Description:** `randomNonceInt64()` used `Date.now() + Math.random()` (not CSPRNG).
- **Fix:** Replaced with `randomBytes(8)` from `node:crypto`, matching the existing pattern in `wallet.ts`.

### H2: Secrets Leaked in Error Messages — FIXED

- **Files:** `src/keychain-setup.ts`, `src/op-setup.ts`, `src/secrets.ts`
- **Description:** `runSecurity` and `runOp` error messages included full command args containing plaintext secret seeds (via `-w <value>` and `[password]=<value>`).
- **Fix:**
  - `keychain-setup.ts`: Added `redactSecurityArgs()` — replaces the value after `-w` with `[REDACTED]`.
  - `op-setup.ts`: Added `redactOpArgs()` — replaces `[password]=<value>` with `[password]=[REDACTED]`.
  - `secrets.ts`: Added `truncateErrorMessage()` (200 char limit) and removed raw command args from `MacOSKeychainSecretProvider` error messages.
- **Tests:** New tests in `keychain-setup.unit.test.ts` and `op-setup.unit.test.ts` verify redaction.

### L1: No Runtime Validation of Config Enum/Numeric Fields — FIXED

- **File:** `src/config.ts`
- **Description:** `onchain_signer_mode` and `default_submit_mode` were type-asserted but never checked at runtime. `default_ttl_seconds` and `assumed_ledger_time_seconds` could silently become `NaN`.
- **Fix:** Added runtime validation for enum values against allowed sets and `isNaN` guards for numeric fields.
- **Tests:** New tests in `config.unit.test.ts` for invalid `onchain_signer_mode`, `default_submit_mode`, and NaN `default_ttl_seconds`.

### L2: Output Files Created With Default Permissions — FIXED

- **File:** `src/core.ts`
- **Description:** `writeOutput` used `writeFileSync` without specifying a `mode`, making signed transaction files potentially world-readable.
- **Fix:** Changed to `writeFileSync(path, content, { encoding: "utf8", mode: 0o600 })`.

### L3: No TLS Enforcement for RPC/Indexer URLs — FIXED

- **File:** `src/config.ts`
- **Description:** User-provided RPC and indexer URLs were not validated for HTTPS.
- **Fix:** Added `warnInsecureUrl()` helper that warns on non-HTTPS URLs for `rpc_url`, `indexer_url`, and `channels_base_url` (except `localhost`/`127.0.0.1`).
- **Tests:** New tests in `config.unit.test.ts` verify warning on remote HTTP URLs and no warning on localhost.

### L4: `.gitignore` Missing Crypto File Patterns — FIXED

- **File:** `.gitignore`
- **Fix:** Added `*.xdr`, `*.seed`, `*.key`, `*.pem`, `*.bundle.json`.

### L9: x402 Settlement Failure Silently Swallowed — FIXED

- **File:** `src/x402.ts`
- **Description:** Settlement parse failure was silently caught; result reported `paid: true` with no error info.
- **Fix:** Added `settlementError?: string` to `X402Result` interface; error message captured in catch block.
- **Tests:** Updated "handles missing settlement header" test to assert `settlementError` field.

### M1: x402 Payment Amount Not Displayed — PARTIAL FIX

- **File:** `src/x402.ts`
- **Description:** Payment amount was not shown before signing. Full audit recommendation included a configurable `max_payment_amount` with abort-if-exceeded.
- **Fix (implemented):** Added `process.stderr.write()` before `createPaymentPayload()` showing amount, scheme, network, and payTo address.
- **Remaining:** Configurable `max_payment_amount` cap and `--yes` bypass not yet implemented. Tracked as future work.

---

## Deferred Items

All IDs below match the original `docs/security-audit.md` finding identifiers.

| ID | Title | Rationale |
|----|-------|-----------|
| M1 (partial) | x402 `max_payment_amount` cap | Display implemented; configurable cap + `--yes` bypass deferred to future PR |
| M2 | Indexer responses trusted without schema validation | `fetchJson<T>()` uses unsafe `as T` cast. Low urgency: indexer URL is user-configured, and fabricated responses would only mislead lookup output, not compromise signing. Consider Zod validation in future. |
| M3 | Secrets visible in process listings during setup | Platform limitation; `security -w` requires arg; investigate `op --stdin` later |
| M4 | Secret cache never cleared | Low risk for short-lived CLI; add `clearCache()` later |
| M5 | Full env inherited by child processes | Filtering risks breaking `op`/`security`; document trust model |
| L5 | `op://` ref format not validated before execution | Malformed refs produce confusing `op` CLI errors but no security impact. Consider pre-validation for UX. |
| L6 | Secret ref metadata exposed in error messages | Partially mitigated by `truncateErrorMessage()`; remaining exposure is vault/item paths (not secrets). |
| L7 | Deterministic deployer keypair | Intentional design for shared Smart Account Kit convention; document it |
| L8 (partial) | Caret version ranges on crypto deps | Mitigated by lockfile + `--frozen-lockfile` in CI. NaN guard added for numeric fields. |

---

## Positive Security Practices

1. **`execFile` everywhere** — no shell injection possible through argument values
2. **Secret-ref indirection** — config files contain only `op://` and `keychain://` references, never raw secrets
3. **Input validation** — thorough checks on hex strings, salt lengths, WASM hashes, sequence numbers, public key formats
4. **Signer integrity checks** — `loadExternalSigner` and `loadDelegatedSigner` verify resolved keypairs match configured public keys
5. **Network passphrase in auth preimage** — prevents cross-network transaction replay
6. **15-second timeout on indexer requests** — prevents indefinite hangs from slow/malicious indexers
7. **Commander-based CLI parsing** — structured argument handling prevents injection
8. **TOML parser safety** — `@iarna/toml` produces plain objects; code manually walks the structure
9. **Secret caching** — reduces subprocess invocations for repeated secret resolution
10. **Platform gating** — macOS keychain operations properly gated behind `process.platform` checks

---

## Dependencies & Supply Chain

| Check | Result |
|-------|--------|
| Known CVEs (`bun audit`) | **None** across 266 packages |
| Lock file integrity | **Pass** — all SHA-512 hashes present |
| Hardcoded secrets in source | **None found** |
| Build config (rolldown) | **Clean** — no plugins, no dynamic code |
| CI lock file enforcement | **Good** — `install:ci` uses `--frozen-lockfile` |

### Dependencies to Monitor

| Dependency | Note |
|------------|------|
| `follow-redirects` (transitive) | Multiple historical CVEs. v1.15.11 is currently clean. |
| `feaxios@0.0.23` (transitive) | Pre-release version (`0.0.x`). Upstream risk. |
| `@actions/exec`, `@actions/io` (transitive) | GitHub Actions libraries — unusual in a CLI context. |
| `@x402/core`, `@x402/stellar` | Relatively new packages. Backed by Coinbase (Apache-2.0). |

---

## Test Coverage Gaps (Tracked, Not Addressed)

| ID | Area | Status |
|----|------|--------|
| T1 | `keychain-setup.ts` error/auto-gen paths (64% coverage) | Partially improved with redaction test |
| T2 | `secrets.ts` non-darwin branches (90% coverage) | Not addressed |
| T3 | `submit.ts` `readDirectOrSecretRef` unsupported-scheme branch | Not addressed |
| T4 | Malformed-but-valid-base64 input to `parseInputFile` | Not addressed |
| T5 | Temp files with seeds not cleaned up in tests | Not addressed |
| T6 | `as never` casts in mocks mask type drift | Not addressed |
| T7 | Config type coercion not tested | Not addressed |
