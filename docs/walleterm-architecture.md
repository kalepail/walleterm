# Walleterm v0 Architecture Draft

## Goal
Build a CLI signer for OpenZeppelin Stellar multisig smart accounts (Ed25519 external signers + delegated signers) that:
- accepts unsigned or partially signed XDR,
- reviews what is being signed,
- signs any signable payloads using keys stored in 1Password,
- outputs signed XDR,
- optionally submits via OpenZeppelin Channels relayer.

## Scope (v0)
- Supported account model: OpenZeppelin smart account with:
  - `Signer::External(verifier, key_data)` Ed25519 signers.
  - `Signer::Delegated(address)` signers.
- Supported signing targets:
  - transaction envelope XDR,
  - `SorobanAuthorizationEntry` XDR,
  - auth entries embedded in `invokeHostFunction` operations in a transaction envelope.
- Supported secret backend: 1Password secret references resolved at runtime.
- Supported submit backends:
  - OpenZeppelin Channels hosted endpoints,
  - optional self-hosted `relayer-plugin-channels` endpoint.

## Non-Goals (v0)
- WebAuthn signing.
- General wallet UX (balances/portfolio/swap).
- Creating/modifying smart-account policies on-chain.

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
- CLI verifies contract wasm hash before signing smart-account auth payloads.

## CLI Commands
- `walleterm inspect --network <name> --in <xdr_or_json_file>`
  - Decode and print what will be signed.
- `walleterm can-sign --network <name> --in <xdr_or_json_file> [--account <alias>]`
  - Dry-run signer matching; no signatures created.
- `walleterm sign --network <name> --in <xdr_or_json_file> --out <file> [--account <alias>] [--ttl-seconds <n>]`
  - Main v0 flow. Signs all eligible payloads and writes signed output.
- `walleterm submit --network <name> --in <signed_xdr_or_bundle> [--wait|--no-wait]`
  - Optional relay submit path.
- `walleterm keys list --account <alias>`
  - Lists configured signer public keys and 1Password refs (never secret values).
- `walleterm keys verify --account <alias>`
  - Resolves 1Password secrets and confirms they derive to configured public keys.

## Input Formats
- `TransactionEnvelope` base64 XDR text.
- `SorobanAuthorizationEntry` base64 XDR text.
- JSON bundle:
  - `{"xdr":"..."}`
  - `{"func":"<host-function-xdr>","auth":["<auth-entry-xdr>", ...]}`

## Output Formats
- For transaction input: signed transaction envelope base64 XDR.
- For auth-entry input: signed auth-entry base64 XDR.
- For bundle input: JSON with signed `func/auth` or signed `xdr` depending on mode.

## Signing Engine

### 1) Envelope signing
Given transaction envelope XDR:
- Parse network-specific tx hash preimage.
- For each configured key that matches required account signature policy, append decorated signature.
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
- For each delegated signer, create an additional delegated auth entry for smart-account `__check_auth` and sign it with the delegated key.

Contract behavior this aligns with:
- Smart account delegates verification by signer type and verifier contract.
- External signer verification path uses `VerifierClient::verify(payload, key_data, sig_data)`.
- Example Ed25519 verifier expects `key_data` 32-byte pubkey and `sig_data` 64-byte signature.
- Delegated signer verification path uses `require_auth_for_args(payload)`.

## Review Pipeline
`inspect` and pre-sign review output should include:
- envelope type, source account, sequence, fee, timebounds,
- operation list,
- per auth entry:
  - credential type (`sourceAccount` or `address`),
  - auth address,
  - nonce,
  - expiration ledger,
  - invocation root summary,
  - whether signable with current keyset,
  - which configured signer(s) will sign.
- smart-account checks:
  - contract ID,
  - on-chain wasm hash vs expected hash,
  - configured signer set overlap.

## 1Password Integration
Two supported runtime patterns:

1) Direct `op read` resolution
- Config stores only secret references, e.g. `op://vault/item/field`.
- CLI resolves at runtime and keeps secrets in memory only.

2) `op run` environment injection
- Users launch CLI via `op run -- walleterm ...`.
- CLI reads key material from env vars mapped in config.

Security constraints:
- Never persist resolved secret values.
- Never print secret material to logs/stdout.
- Validate that resolved secret derives to configured public key.
- Accept only Stellar secret seeds (`S...`) for signer keys.
- Prefer 1Password service accounts for automated non-interactive runs.

## Relayer Integration
Default behavior:
- `sign` is default workflow and returns signed XDR without submission.
- `submit` is optional and explicit.

### Channels Hosted Mode (recommended)
- Mainnet base URL: `https://channels.openzeppelin.com`
- Testnet base URL: `https://channels.openzeppelin.com/testnet`
- API key from 1Password secret reference.

Submission methods:
- `submitTransaction({ xdr })` for complete signed envelope.
- `submitSorobanTransaction({ func, auth })` when sending host function and auth entries.

### Self-Hosted Channels Plugin Mode
- Base URL = user relayer endpoint.
- Optional `pluginId` and `adminSecret` for management API.

## Config Model (TOML)
Top-level sections:
- `[networks.<name>]`
  - `rpc_url`, `network_passphrase`, `channels_base_url`, `channels_api_key_ref`
- `[smart_accounts.<alias>]`
  - `network`, `contract_id`, `expected_wasm_hash`
- `[[smart_accounts.<alias>.delegated_signers]]`
  - `name`
  - `address` (G-address)
  - `secret_ref` (1Password secret reference to Stellar seed)
  - `enabled`
- `[[smart_accounts.<alias>.external_signers]]`
  - `name`
  - `verifier_contract_id`
  - `public_key_hex` (32-byte Ed25519 pubkey)
  - `secret_ref` (1Password secret reference)
  - `enabled`

Validation rules:
- All signer public keys unique within an account.
- Secret-derived pubkey must equal configured `public_key_hex`.
- All signer secrets must be valid Stellar seeds (`S...`).
- Signer match policy: `subset` in v0:
  - Config signer set may be a subset of on-chain signers.
  - Tool signs only entries it can satisfy and reports skipped entries.

## Expiration Policy
- Default auth TTL: 30 seconds.
- CLI override: `--ttl-seconds <n>`.
- Ledger conversion: `signatureExpirationLedger = latestLedger + ceil(ttl_seconds / 6)`.
- Assumes 6-second ledgers.

## Error Model
Classes:
- Parse errors: invalid base64/XDR, unsupported envelope types.
- Signability errors: no matching key, network mismatch, wasm hash mismatch.
- Policy errors: signer configured but not allowed by on-chain smart-account state.
- Submit errors: relayer transport/execution errors, timeout, on-chain failure.

## Suggested Implementation Order
1. Project bootstrap + config loader + network profile validation.
2. XDR parser + inspect command.
3. 1Password resolver + key verification.
4. Envelope signing.
5. Generic auth-entry signing.
6. OZ smart-account signature-map signing.
7. Submit command with channels hosted mode.
8. Self-hosted plugin mode and management helpers.

## Resolved Decisions
1. Signer matching mode is `subset` for v0.
