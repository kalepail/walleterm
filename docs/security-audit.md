# Walleterm Security Audit

**Date:** 2026-03-16
**Scope:** Full codebase review — secrets/credentials, wallet/crypto, CLI input/config, test coverage, dependencies/supply chain

## Overall Assessment

The codebase has a **strong security posture** for a CLI tool at this stage. No critical vulnerabilities were found that would allow direct key extraction or unauthorized transaction signing. The architecture makes excellent design choices:

- **Secret-ref indirection** via 1Password (`op://`) and macOS Keychain (`keychain://`) — secrets never stored in config files
- **`execFile` (not `exec`)** for all subprocess calls — eliminates shell injection
- **Network passphrase binding** in Soroban auth preimages — prevents cross-network replay
- **Zero `console.log` of secrets** across the entire `src/` directory
- **Lean dependency tree** — 6 production deps, 266 total packages, no known CVEs
- **Structured CLI parsing** via Commander — prevents argument injection

The findings below are defense-in-depth improvements organized by priority.

---

## Findings

### HIGH

#### H1: Weak Nonce Generation

- **File:** `src/core.ts:441`
- **Description:** `randomNonceInt64()` uses `Date.now() + Math.random()` hashed through SHA-256. `Date.now()` provides millisecond resolution (easily guessable) and `Math.random()` is not a CSPRNG. The string conversion of `Date.now() + Math.random()` collapses the two values into a single floating-point addition, further reducing entropy. The correct pattern already exists in `wallet.ts:86` using `crypto.randomBytes(8)`.
- **Risk:** An attacker who can predict the nonce could potentially replay or pre-compute authorization entries. Partially mitigated by `signatureExpirationLedger` TTL, but the nonce is a critical anti-replay mechanism.
- **Fix:** Replace with `randomBytes(8)` from `node:crypto`, matching `wallet.ts`:
  ```typescript
  import { randomBytes } from "node:crypto";
  function randomNonceInt64(): xdr.Int64 {
    const raw = randomBytes(8);
    const value = BigInt(`0x${raw.toString("hex")}`) & ((1n << 63n) - 1n);
    return xdr.Int64.fromString(value.toString());
  }
  ```
- **Status:** [ ] Not started

#### H2: Secrets Leaked in Error Messages

- **Files:** `src/keychain-setup.ts:80`, `src/op-setup.ts:68`, `src/secrets.ts:126`
- **Description:** When `security add-generic-password` or `op item create/edit` fails, `runSecurity` and `runOp` include the full command args in the thrown Error. During setup, these args contain plaintext secret seeds (via `-w <value>` and `[password]=<value>` patterns). These errors can propagate to logs, monitoring systems, CI output, or crash reports.
- **Risk:** Secret seed leakage in any environment that captures stderr/exceptions (CI/CD pipelines, error tracking services, terminal scrollback).
- **Fix:** Redact sensitive argument values before constructing error messages:
  - In `runSecurity`: replace the value after `-w` with `[REDACTED]`
  - In `runOp`: replace `[password]=...` field values with `[password]=[REDACTED]`
  - In `MacOSKeychainSecretProvider.resolve`: trim args from error output
- **Status:** [ ] Not started

---

### MEDIUM

#### M1: x402 Payment Amount Not Validated Before Signing

- **File:** `src/x402.ts:100-126`
- **Description:** `executeX402Request` filters payment options by network and scheme but does not validate or bound-check the `amount` before passing it to `createPaymentPayload`. A malicious server could respond with an arbitrarily large amount in the 402 response, and the client would sign and pay without user confirmation.
- **Risk:** A malicious or compromised x402-protected server could trigger unexpectedly large payments. The `--dry-run` flag exists but is opt-in.
- **Fix:** Add a configurable `max_payment_amount` (via config or CLI flag). Abort if exceeded unless `--yes` is passed. Always display the payment amount to stderr before signing.
- **Status:** [ ] Not started

#### M2: Indexer Responses Trusted Without Schema Validation

- **File:** `src/wallet.ts:91-103`
- **Description:** `fetchJson<T>()` performs an unsafe type assertion (`as T`) on the response body without validating the Content-Type header or JSON schema. Since the indexer URL is user-configurable (`--indexer-url` or config), a malicious indexer could return fabricated `contract_id` or `signer_address` data that misleads wallet lookup and signer mutation flows.
- **Risk:** Fabricated indexer responses could cause the tool to sign auth entries for incorrect contracts or addresses.
- **Fix:** Validate that critical response fields (`contract_id`, `signer_address`) are present and well-formed before returning. Consider using Zod for runtime schema validation.
- **Status:** [ ] Not started

#### M3: Secrets Visible via Process Listing During Setup

- **Files:** `src/keychain-setup.ts:197`, `src/op-setup.ts:211-233`
- **Description:** Secret seeds are passed as CLI arguments to `security` (via `-w <value>`) and `op` (via `field[password]=<value>`). On Unix systems, CLI arguments are visible to all users via `ps aux` or `/proc/<pid>/cmdline` for the duration of process execution.
- **Risk:** Brief window of secret exposure to other processes on the same machine. More concerning in shared/CI environments.
- **Fix:** For macOS Keychain this is a platform limitation (`security add-generic-password` requires `-w`). For 1Password, investigate `op item create --stdin` or environment-variable-based field values. Document the limitation for the keychain path.
- **Status:** [ ] Not started

#### M4: Secret Cache Never Cleared

- **File:** `src/secrets.ts:148`
- **Description:** `SecretResolver` stores resolved secrets in `private readonly cache = new Map<string, string>()` with no TTL, maximum size, or `clear()` method. All secrets ever resolved remain as plaintext JavaScript strings in the V8 heap for the entire process lifetime.
- **Risk:** Increases window for memory-scraping attacks in a compromised-process scenario. Low risk for a short-lived CLI, but relevant if walleterm is used as a library or in long-running contexts.
- **Fix:** Add a `clearCache()` method to `SecretResolver`. Call it after signing/setup operations complete.
- **Status:** [ ] Not started

#### M5: Full Process Environment Inherited by Child Processes

- **Files:** `src/secrets.ts:39`, `src/keychain-setup.ts:76`, `src/op-setup.ts:63`
- **Description:** `execFile` calls pass `env: process.env`, propagating all environment variables (potentially containing other API keys, tokens, or credentials) to `op` and `security` subprocesses.
- **Risk:** Unrelated secrets in the environment are exposed to credential-provider subprocesses.
- **Fix:** Filter the environment to pass only necessary variables. At minimum, document that all environment variables are inherited.
- **Status:** [ ] Not started

---

### LOW

#### L1: No Runtime Validation of `onchain_signer_mode`

- **File:** `src/config.ts:147`
- **Description:** The `onchain_signer_mode` field is type-asserted as `SignerMode` but never checked at runtime. A TOML config with `onchain_signer_mode = "anything"` would be silently accepted.
- **Fix:** Add runtime validation against the set of valid modes (`"subset"`, etc.).
- **Status:** [ ] Not started

#### L2: Output Files Created With Default Permissions

- **File:** `src/core.ts:999-1001`
- **Description:** `writeOutput` uses `writeFileSync` without specifying a `mode`. Files containing signed transactions could be world-readable (depending on umask).
- **Fix:** Use `writeFileSync(path, content, { encoding: "utf8", mode: 0o600 })`.
- **Status:** [ ] Not started

#### L3: No TLS Enforcement for RPC/Indexer URLs

- **Files:** `src/wallet.ts`, `src/submit.ts`
- **Description:** User-provided RPC and indexer URLs are not validated for HTTPS. An `http://` URL would transmit transaction data, signed envelopes, and API keys in the clear. Default URLs are all HTTPS, but overrides are unchecked.
- **Fix:** Warn (or reject) non-HTTPS URLs unless they target `localhost`/`127.0.0.1` or an explicit `--allow-insecure` flag is set.
- **Status:** [ ] Not started

#### L4: `.gitignore` Missing Crypto File Patterns

- **File:** `.gitignore`
- **Description:** The gitignore covers `.env`, `dist/`, `walleterm.toml`, but is missing patterns for crypto-related files that a wallet CLI user might generate.
- **Fix:** Add `*.pem`, `*.key`, `*.xdr`, `*.seed`, `*.bundle.json`.
- **Status:** [ ] Not started

#### L5: `op://` Ref Format Not Validated Before Execution

- **File:** `src/secrets.ts:88-104`
- **Description:** `OnePasswordSecretProvider.resolve` passes the entire ref string to `op read` without validating it matches the expected `op://<vault>/<item>/<field>` format. Malformed refs produce confusing errors from `op` CLI.
- **Fix:** Validate the ref matches the expected 3-segment path pattern before invoking `op read`.
- **Status:** [ ] Not started

#### L6: Secret Ref Metadata Exposed in Error Messages

- **Files:** `src/secrets.ts:50,94,126`
- **Description:** Error messages from secret resolution include vault/item paths, child process stderr, and full command arguments. While not secrets themselves, they reveal the structure of the credential store.
- **Fix:** Sanitize error messages to include minimum information needed for debugging.
- **Status:** [ ] Not started

#### L7: Deterministic Deployer Keypair From Public Constant

- **File:** `src/wallet.ts:63-71`
- **Description:** `smartAccountKitDeployerKeypair()` derives a keypair from the hardcoded string `"openzeppelin-smart-account-kit"`. Anyone reading the source can derive the same keypair. This is by design (shared deployer for the Smart Account Kit convention) but is underdocumented.
- **Fix:** Add clear documentation that this keypair is intentionally deterministic and public. Ensure the deployer account is never used to hold meaningful balances.
- **Status:** [ ] Not started

#### L8: Caret Version Ranges on Crypto Dependencies

- **File:** `package.json`
- **Description:** Production dependencies use `^` (caret) ranges: `@stellar/stellar-sdk: ^14.6.0`, `@x402/core: ^2.7.0`, `@x402/stellar: ^2.7.0`. Any `bun install` (without `--frozen-lockfile`) could pull in new minor/patch versions. Mitigated by `bun.lock` and the `install:ci` script using `--frozen-lockfile`.
- **Fix:** Consider exact pinning for cryptographic/payment dependencies.
- **Status:** [ ] Not started

#### L9: x402 Settlement Failure Silently Swallowed

- **File:** `src/x402.ts:136-142`
- **Description:** If `getPaymentSettleResponse` throws, the error is caught and `settlement` is set to `undefined`, but the result still reports `paid: true`. The user may believe a payment settled when it did not.
- **Fix:** Include a `settlementError` field or warning in the result when settlement fetch fails.
- **Status:** [ ] Not started

---

### TEST QUALITY & COVERAGE GAPS

#### T1: `keychain-setup.ts` at 64% Coverage

- **Missing:** `ensureMacOSAvailable` (non-macOS path), `resolveChannelsApiKey` (fetch/auto-generation flow), `inferChannelsGenUrl`, `errorMessage` helper, `runSecurity` catch path, `networkDefaults` branches.
- **Impact:** The keychain setup flow's error handling and auto-generation logic is entirely untested. The equivalent `op-setup.ts` logic is tested but not the keychain variant.
- **Status:** [ ] Not started

#### T2: `secrets.ts` at 90% Coverage

- **Missing:** `canUseMacOSKeychain` false branch (non-darwin, no explicit bin), `MacOSKeychainSecretProvider.resolve` with custom keychain path, exec failure and empty-value error paths, `SecretResolver.resolve` bare-string-without-scheme error.
- **Status:** [ ] Not started

#### T3: `submit.ts` Uncovered Branch

- **Missing:** `readDirectOrSecretRef` — the `looksLikeSecretRef(raw)` branch that throws for unsupported scheme refs is never tested.
- **Status:** [ ] Not started

#### T4: No Tests for Malformed-but-Valid-Base64 Input

- **Description:** `parseInputFile` is tested with clearly invalid strings but never with valid base64 that decodes to invalid XDR. Such inputs silently fall through to JSON parsing instead of producing a clear error.
- **Status:** [ ] Not started

#### T5: Temp Files With Seeds Not Cleaned Up in Tests

- **Files:** E2E and live tests, `tests/helpers/fake-security.ts`
- **Description:** Tests create temp directories via `mkdtempSync` and write secret seeds to files but never clean up in `afterAll` hooks. The `fake-security.ts` helper also logs all commands (including `-w <secret>`) to a log file with default permissions.
- **Status:** [ ] Not started

#### T6: `as never` Casts in Mocks Mask Type Drift

- **Files:** `tests/unit/submit.unit.test.ts`, `tests/unit/cli.unit.test.ts`
- **Description:** Mock return values use `as never` to suppress type checking. SDK upgrades that change return shapes would be silently masked. `SecretResolver` mock in `cli.unit.test.ts` is missing `isSupportedRef()` and `supportedSchemes()` methods.
- **Status:** [ ] Not started

#### T7: Config Type Coercion Not Tested

- **Description:** No test provides unexpected types in config fields (e.g., `rpc_url = 42`, `network_passphrase = true`). The code uses `String()` coercion, so `String(42)` silently becomes `"42"`. These would be accepted but produce broken configurations.
- **Status:** [ ] Not started

---

## Dependencies & Supply Chain

| Check | Result |
|-------|--------|
| Known CVEs (`bun audit`) | **None** across 266 packages |
| Lock file integrity | **Pass** — all SHA-512 hashes present, consistent with `package.json` |
| Hardcoded secrets in source | **None found** |
| Build config (rolldown) | **Clean** — no plugins, no dynamic code, no injection vectors |
| CI lock file enforcement | **Good** — `install:ci` uses `--frozen-lockfile` |

### Dependencies to Monitor

| Dependency | Note |
|------------|------|
| `follow-redirects` (transitive, via axios via @openzeppelin/relayer-plugin-channels) | Multiple historical CVEs. v1.15.11 is currently clean. |
| `feaxios@0.0.23` (transitive, via @stellar/stellar-sdk) | Pre-release version (`0.0.x`). Upstream risk. |
| `@actions/exec`, `@actions/io` (transitive, via @openzeppelin/relayer-plugin-channels) | GitHub Actions libraries — unusual in a CLI context, increases surface area. |
| `@x402/core`, `@x402/stellar` | Relatively new packages. Backed by Coinbase (Apache-2.0). |

---

## Positive Security Practices

These are things the codebase already does well:

1. **`execFile` everywhere** — no shell injection possible through argument values
2. **Secret-ref indirection** — config files contain only `op://` and `keychain://` references, never raw secrets
3. **Input validation** — thorough checks on hex strings, salt lengths, WASM hashes, sequence numbers, public key formats
4. **Signer integrity checks** — `loadExternalSigner` and `loadDelegatedSigner` verify resolved keypairs match configured public keys
5. **Network passphrase in auth preimage** — prevents cross-network transaction replay
6. **15-second timeout on indexer requests** — prevents indefinite hangs from slow/malicious indexers
7. **Commander-based CLI parsing** — structured argument handling prevents injection
8. **TOML parser safety** — `@iarna/toml` produces plain objects; code manually walks the structure (no `Object.assign` from untrusted sources)
9. **Secret caching** — reduces subprocess invocations for repeated secret resolution
10. **Platform gating** — macOS keychain operations properly gated behind `process.platform` checks
