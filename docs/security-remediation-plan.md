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

- **Files:** `src/core.ts`, `src/cli.ts`
- **Description:** `writeOutput` used `writeFileSync` without specifying a `mode`, making signed transaction files potentially world-readable.
- **Fix:** Changed `writeOutput()` to use `writeFileSync(path, content, { encoding: "utf8", mode: 0o600 })`. The `pay --out` path in `src/cli.ts` now also writes response bodies with `mode: 0o600`.

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

### M1: x402 Payment Amount Not Displayed — FIXED

- **Files:** `src/x402.ts`, `src/config.ts`, `src/cli.ts`
- **Description:** Payment amount was not shown before signing. Full audit recommendation included a configurable `max_payment_amount` with abort-if-exceeded.
- **Fix:** Added `process.stderr.write()` before `createPaymentPayload()` showing amount, scheme, network, and payTo address. Added `max_payment_amount` field to `X402Config` with validation. Added `--yes` CLI flag to skip cap check. `executeX402Request` now aborts if amount exceeds configured cap (unless `--yes` is passed).

### M2: Indexer Responses Validated With Zod — FIXED

- **File:** `src/wallet.ts`
- **Description:** `fetchJson<T>()` used unsafe `as T` cast without schema validation.
- **Fix:** Added Zod schemas for all indexer response types (`AddressLookupResponseSchema`, `CredentialLookupResponseSchema`, `ContractSignersResponseSchema`). `fetchJson<T>()` now accepts an optional `schema?: z.ZodType<T>` parameter. All security-sensitive callers pass their Zod schema.
- **Dependencies:** Added `zod` as a production dependency.

### M3: Secrets Visible in Process Listings — DOCUMENTED

- **Files:** `src/keychain-setup.ts`, `src/op-setup.ts`
- **Description:** Secret seeds passed as CLI arguments are visible via `ps aux` during subprocess execution.
- **Fix:** Added stderr warning during setup: "Secret values are briefly visible in process listings during storage. This is a platform limitation of the security/op CLI tools." This is a platform limitation — `security -w` requires the value as an argument.

### M4: Secret Cache Clearing — FIXED

- **Files:** `src/secrets.ts`, `src/cli.ts`
- **Description:** `SecretResolver` stored secrets in memory with no clearing mechanism.
- **Fix:** Added `clearCache()` method to `SecretResolver`. All CLI command handlers now call `resolver.clearCache()` after secret resolution completes.

### M5: Environment Filtering for Child Processes — FIXED

- **Files:** `src/secrets.ts`, `src/keychain-setup.ts`, `src/op-setup.ts`
- **Description:** `execFile` calls passed `env: process.env`, exposing all environment variables to subprocesses.
- **Fix:** Added `safeEnv()`/`filteredEnv()` helpers that filter to a safe allowlist: `PATH`, `HOME`, `USER`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, plus `OP_*` (for 1Password) and `WALLETERM_*` (for testing/config) prefixed variables.

### L5: `op://` Ref Format Validated — FIXED

- **File:** `src/secrets.ts`
- **Description:** Malformed `op://` refs produced confusing `op` CLI errors.
- **Fix:** `OnePasswordSecretProvider.resolve()` now validates that the ref has exactly 3 non-empty path segments (`op://<vault>/<item>/<field>`) before invoking `op read`. Throws a descriptive error on malformed refs.

### L7: Deterministic Deployer Keypair Documented — FIXED

- **File:** `src/wallet.ts`
- **Description:** `smartAccountKitDeployerKeypair()` derives a keypair from a hardcoded public constant but was underdocumented.
- **Fix:** Added JSDoc comment explaining the keypair is intentionally deterministic, follows the OpenZeppelin Smart Account Kit convention, and should never hold meaningful balances.

### L8: Crypto Dependencies Pinned — FIXED

- **File:** `package.json`
- **Description:** Production crypto/payment dependencies used caret (`^`) version ranges.
- **Fix:** Pinned exact versions for `@stellar/stellar-sdk`, `@x402/core`, and `@x402/stellar`.

---

## Deferred Items

All IDs below match the original `docs/security-audit.md` finding identifiers.

| ID | Title | Rationale |
|----|-------|-----------|
| L6 | Secret ref metadata exposed in error messages | Partially mitigated by `truncateErrorMessage()`; remaining exposure is vault/item paths (not secrets). Acceptable risk — paths are not secrets. |

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

## Test Coverage Gaps — MOSTLY ADDRESSED

| ID | Area | Status |
|----|------|--------|
| T1 | `keychain-setup.ts` error/auto-gen paths | **Fixed** — Added 9 tests: `ensureMacOSAvailable` non-macOS path, `errorMessage` catch path, `networkDefaults` branches, `resolveChannelsApiKey` auto-generation |
| T2 | `secrets.ts` non-darwin branches | **Fixed** — Added 6 tests: `canUseMacOSKeychain` false branch, custom keychain path, exec failure/empty value errors, bare-string-without-scheme, `clearCache()` verification |
| T3 | `submit.ts` `readDirectOrSecretRef` unsupported-scheme branch | **Fixed** — Added 1 test: passes `env://something` to verify unsupported scheme error |
| T4 | Malformed-but-valid-base64 input to `parseInputFile` | **Fixed** — Added 1 test: valid base64 of garbage data, verifies "neither base64 XDR nor JSON" error |
| T5 | Temp files with seeds not cleaned up in tests | **Partially fixed** — Added `cleanup()` method to `FakeSecurityFixture`, set `mode: 0o600` on log file and store file writes. Some tests still create temp dirs/files without explicit cleanup hooks. |
| T6 | `as never` casts in mocks mask type drift | **Partially fixed** — Replaced `as never` with `satisfies ChannelsTransactionResponse` on 3 mock return values in submit tests and properly typed `getLatestLedger` mock. Left complex XDR-related casts as-is |
| T7 | Config type coercion not tested | **Fixed** — Added 1 test: numeric/boolean config values coerce via `String()` without crashing |
