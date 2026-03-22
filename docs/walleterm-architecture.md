# Walleterm Current Architecture

## Goal
Build a CLI signer for OpenZeppelin Stellar multisig smart accounts (Ed25519 external signers + delegated signers) that:
- accepts unsigned or partially signed XDR,
- reviews what is being signed,
- signs any signable payloads using keys resolved from a supported secret store,
- outputs signed XDR,
- optionally submits via OpenZeppelin Channels relayer or Stellar RPC,
- optionally pays x402- or MPP-protected HTTP endpoints with a Stellar keypair.

## Scope (v0)
- Supported account model: OpenZeppelin smart account with:
  - `Signer::External(verifier, key_data)` Ed25519 signers.
  - `Signer::Delegated(address)` signers.
- Supported signing targets:
  - transaction envelope XDR,
  - `SorobanAuthorizationEntry` XDR,
  - auth entries embedded in `invokeHostFunction` operations in a transaction envelope.
- Supported secret backends:
  - 1Password secret references resolved at runtime
  - macOS keychain secret references resolved at runtime
- Supported submit backends:
  - OpenZeppelin Channels hosted endpoints,
  - optional self-hosted `relayer-plugin-channels` endpoint,
  - direct Stellar RPC submission for signed transaction envelopes.
- Supported payment backend:
  - x402- or MPP-protected HTTP endpoints using a Stellar payer keypair.

## Non-Goals
- WebAuthn signing.
- General wallet UX (balances/portfolio/swap).
- Full policy-management UX beyond wallet deployment and signer add/remove flows.

## Network Profiles
Defaults:
- Mainnet RPC: `https://rpc.lightsail.network/`
- Testnet RPC: `https://soroban-rpc.testnet.stellar.gateway.fm`

Passphrases:
- Mainnet: `Public Global Stellar Network ; September 2015`
- Testnet: `Test SDF Network ; September 2015`

Contract verification:
- Expected smart-account WASM hash on both networks:
  - `a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e`
- `expected_wasm_hash` is validated in config and can drive `wallet create` when an account alias is selected, but full post-deploy/on-chain contract verification is still future work.

## CLI Commands
- `walleterm review --network <name> --in <xdr_or_json_file> [--account <alias>]`
  - Primary pre-sign flow. Decode the payload, show signability for the selected wallet, and include signer reconciliation details when indexer lookup succeeds.
- `walleterm sign --network <name> --in <xdr_or_json_file> --out <file> [--account <alias>] [--ttl-seconds <n>]`
  - Main signing flow. Signs all eligible payloads and writes signed output. When `strict_onchain = true`, this path first verifies configured delegated/external signers against on-chain indexer results.
- `walleterm submit --network <name> --in <signed_xdr_or_bundle> [--mode channels|rpc]`
  - Optional submit path. RPC mode supports signed tx envelopes only.
- `walleterm pay <url>`
  - Makes an HTTP request to an x402- or MPP-protected endpoint using a configured Stellar payer.
- `walleterm channel open|topup|status|settle|close|close-start|refund`
  - Manages local MPP one-way payment channels and the remembered voucher state used by channel payments, including funder-side and recipient-side lifecycle operations.
- `walleterm wallet lookup --secret-ref <ref>` or `--account <alias>` or `--address <G...|C...>` or `--contract-id <C...>`
  - Wallet discovery and introspection flow.
- `walleterm wallet signer generate`
  - Generates a Stellar signer keypair.
- `walleterm wallet signer add|remove --account <alias> ...`
  - Builds and signs signer-management bundles, with optional strict pre-mutation signer reconciliation.
- `walleterm wallet create ...`
  - Builds the deployment transaction for a new smart account and can optionally submit it. It can also derive the WASM hash from account config.

## Input Formats
- `TransactionEnvelope` base64 XDR text.
- `SorobanAuthorizationEntry` base64 XDR text.
- JSON bundle:
  - `{"xdr":"..."}`
  - `{"func":"<host-function-xdr>","auth":["<auth-entry-xdr>", ...]}`

## Output Formats
- For transaction input: signed transaction envelope base64 XDR.
- For auth-entry input: signed auth-entry base64 XDR, or JSON `{ auth: [...] }` if delegated signer expansion produces multiple auth entries.
- For bundle input: JSON with signed `func/auth`.

## Signing Engine

### 1) Envelope signing
Given transaction envelope XDR:
- Parse network-specific tx hash preimage.
- Collect signing addresses from transaction and operation sources.
- For each local key whose public key appears in those signing addresses, append a decorated signature.
- Preserve existing signatures.

### 2) Auth-entry signing (generic address credentials)
For `SorobanAuthorizationEntry` with `sorobanCredentialsAddress` where address is G-account:
- Build `HashIdPreimageSorobanAuthorization` using:
  - `networkId = sha256(networkPassphrase)`
  - `nonce` from credentials
  - `signatureExpirationLedger` (derived from TTL)
  - `rootInvocation`
- Sign `sha256(preimageXdr)` with matching Ed25519 key.
- Set signature in Stellar expected `ScVal` shape.

### 3) OZ smart-account auth-entry signing
For `SorobanAuthorizationEntry` where address is configured smart-account contract:
- Compute signature payload exactly as above from entry preimage.
- In the smart-account signature map (`Signatures(Map<Signer, Bytes>)`), fill each configured signer value:
  - `Signer::External(verifier_contract, signer_public_key_bytes)` => raw 64-byte Ed25519 signature over payload hash.
  - `Signer::Delegated(address)` => empty bytes marker.
- Sort map entries deterministically by key XDR bytes.
- If the signature map is empty, synthesize signer-map entries from locally configured smart-account signers.
- In subset-style behavior, unknown signer entries are left untouched and only matching local signer entries are filled.
- For each delegated signer, create an additional delegated auth entry for smart-account `__check_auth` and sign it with the delegated key.

Contract behavior this aligns with:
- Smart account delegates verification by signer type and verifier contract.
- External signer verification path uses `VerifierClient::verify(payload, key_data, sig_data)`.
- Example Ed25519 verifier expects `key_data` 32-byte pubkey and `sig_data` 64-byte signature.
- Delegated signer verification path uses `require_auth_for_args(payload)`.

## Review Pipeline
Current `review` output is compact JSON and includes:
- input inspection:
  - tx envelope type, operation count, auth-entry count, or
  - auth-entry credential type, address, nonce, and expiration ledger
- signability summary:
  - matching envelope signer addresses
  - count/details for signable auth entries
- selected account alias and contract ID when an account can be resolved

It does not currently emit the richer on-chain verification and transaction-detail view envisioned in earlier drafts.

Current signer reconciliation output includes:
- configured delegated/external signers from local config,
- indexer-reported on-chain delegated/external signers,
- missing/extra differences under `subset` or `exact` mode,
- a non-fatal reconciliation error string when review cannot query the indexer.

## Credential Provider Integration
Runtime secret resolution is provider-backed and ref-based.

Current supported providers:
- 1Password via `op://...`
- macOS keychain via `keychain://...`

Current 1Password runtime pattern:

1) Direct `op read` resolution
- Config stores secret refs like `op://vault/item/field`.
- CLI resolves at runtime and keeps secrets in memory only.

`op run -- ...` can still be used to launch the CLI itself, but there is no dedicated env-mapped signer-secret config mode today.

macOS keychain runtime pattern:
- Config stores refs like `keychain://walleterm-testnet/delegated_seed`.
- CLI resolves them through macOS `security find-generic-password`.
- Optional `?keychain=<path>` query selects a custom keychain file.

Security constraints:
- Never persist resolved secret values.
- Never print secret material to logs/stdout.
- Validate that resolved secret derives to configured public key.
- Accept only Stellar secret seeds (`S...`) for signer keys.
- Prefer 1Password service accounts for automated non-interactive runs.
- The current macOS keychain backend uses the system `security` CLI, which gives standard unlocked-keychain behavior rather than 1Password-style per-read approval prompts.
- Keep provider setup/bootstrap commands separate from runtime resolution because write semantics vary by store.
- Setup commands briefly expose secret values in process listings while invoking `op` or `security`.
- Child processes receive a reduced environment rather than the full parent environment.

## Relayer Integration
Default behavior:
- `sign` is default workflow and returns signed XDR without submission.
- `submit` is optional and explicit.

### Channels Hosted Mode (recommended)
- Mainnet base URL: `https://channels.openzeppelin.com`
- Testnet base URL: `https://channels.openzeppelin.com/testnet`
- API key from a provider-backed secret reference or direct CLI override.

Submission methods:
- `submitTransaction({ xdr })` for complete signed envelope.
- `submitSorobanTransaction({ func, auth })` when sending host function and auth entries.

### Self-Hosted Channels Plugin Mode
- Base URL = user relayer endpoint.
- Optional `pluginId` for self-hosted plugin routing.

### RPC submit mode
- Direct Stellar RPC submission is supported for signed transaction envelopes only.
- Signed `{func, auth[]}` bundles and standalone auth entries cannot be submitted through RPC mode.

## Payment Flow
- `walleterm pay <url>` makes an HTTP request and retries after signing either an x402 or MPP payment payload when the server responds with HTTP 402.
- The CLI now delegates pay-path orchestration to `src/payments/*`, with shared protocol selection and result normalization in `src/payments/index.ts` and protocol-specific adapters in `src/payments/x402.ts` and `src/payments/mpp.ts`.
- Protocol selection comes from `--protocol` or `[payments].default_protocol`, with x402 as the compatibility default.
- Payer selection is protocol-specific: x402 resolves from `--secret-ref` or `[payments.x402]`; MPP resolves from `--secret-ref` or `[payments.mpp]`.
- Protocol-specific `max_payment_amount` settings set a payment cap unless `--yes` is passed.
- `--dry-run` returns the 402 challenge details without paying.
- The canonical payment modes are x402 `exact`, x402 `channel`, MPP `charge`, and MPP `channel`.
- MPP channel payments persist the latest voucher amount/signature locally so the CLI can top up, inspect, and close the active channel later.
- Current x402 and MPP network support is mapped from the standard Stellar testnet and mainnet passphrases only.

## Config Model (TOML)
Top-level sections:
- `[app]`
  - `default_network`, `strict_onchain`, `onchain_signer_mode`, `default_ttl_seconds`, `assumed_ledger_time_seconds`, `default_submit_mode`
- `[networks.<name>]`
  - `rpc_url`, `network_passphrase`, `indexer_url`, `channels_base_url`, `channels_api_key_ref`, `deployer_secret_ref`, `x402_facilitator_url`
- `[payments]`
  - `default_protocol`
- `[payments.mpp]`
  - `default_intent`, `default_payer_secret_ref`, `max_payment_amount`
- `[payments.mpp.channel]`
  - `default_channel_contract_id`, `default_deposit`, `factory_contract_id`, `token_contract_id`, `recipient`, `recipient_secret_ref`, `refund_waiting_period`, `source_account`, `state_file`
- `[payments.x402]`
  - `default_payer_secret_ref`, `max_payment_amount`, `default_scheme`
- `[payments.x402.channel]`
  - `state_file`, `default_deposit`, `max_deposit_amount`, `commitment_secret_ref`
- `[smart_accounts.<alias>]`
  - `network`, `contract_id`, `expected_wasm_hash`
- `[[smart_accounts.<alias>.delegated_signers]]`
  - `name`
  - `address` (G-address)
  - `secret_ref` (provider-backed secret reference to Stellar seed)
  - `enabled`
- `[[smart_accounts.<alias>.external_signers]]`
  - `name`
  - `verifier_contract_id`
  - `public_key_hex` (32-byte Ed25519 pubkey)
  - `secret_ref` (provider-backed secret reference)
  - `enabled`
Validation rules:
- All signer public keys unique within an account.
- Secret-derived pubkey must equal configured `public_key_hex`.
- All signer secrets must be valid Stellar seeds (`S...`).
- Config loader validates enum/numeric fields and warns on non-HTTPS remote RPC/indexer/Channels URLs.
- `strict_onchain` and `onchain_signer_mode` are enforced today for `sign` and `wallet signer add/remove` by reconciling configured signers against indexer-reported on-chain signers.
- `default_submit_mode = channels` is enforced today for `wallet create` by auto-submitting through Channels.
- `expected_wasm_hash` is validated and can be consumed by `wallet create`, but broader on-chain contract verification remains future work.
- `x402_facilitator_url` is still config-only and not wired into the current x402 client runtime.

## Expiration Policy
- Default auth TTL: 30 seconds.
- CLI override: `--ttl-seconds <n>`.
- Ledger conversion: `signatureExpirationLedger = latestLedger + ceil(ttl_seconds / 6)`.
- Assumes 6-second ledgers.

## Error Model
Classes:
- Parse errors: invalid base64/XDR, unsupported envelope types.
- Signability errors: no matching key, network mismatch, unsupported signer-map shape.
- Policy errors: signer configured but not resolvable from local configuration.
- Submit errors: relayer transport/execution errors, timeout, on-chain failure.
- Payment errors: unsupported passphrase-to-protocol mapping, max-payment cap exceeded, malformed x402 or MPP challenge, conflicting Authorization headers for MPP.

## Notes
- The Smart Account Kit deployer is intentionally deterministic and public. It should never hold meaningful balances.
- Setup commands store delegated signer and Channels API key material by default; external signer seeds are provisioned separately.
