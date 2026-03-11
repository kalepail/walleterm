# Walleterm Credential Providers

This document defines the secret-store abstraction used by `walleterm`.

## Design goal

`walleterm` signs Stellar payloads with Ed25519 signer seeds. It does not need a full password-manager API at runtime. It only needs one capability:

- resolve a secret reference string into the underlying secret value

That design keeps the runtime abstraction small and lets different backends expose whatever native object model they want.

## Runtime provider contract

At runtime, each provider implements:

- `scheme`: the URI scheme it owns, such as `op` or `keychain`
- `resolve(ref)`: return the secret value for that reference

`walleterm` itself only understands:

- direct values
- provider-backed secret refs

Everything else is provider-specific.

## Current providers

### 1Password

- Scheme: `op://`
- Example: `op://Private/walleterm-testnet/delegated_seed`
- Runtime behavior: shell out to `op read <ref>`
- Setup flow: `walleterm setup op`

### macOS keychain

- Scheme: `keychain://`
- Example: `keychain://walleterm-testnet/delegated_seed`
- Optional custom keychain:
  - `keychain://walleterm-testnet/delegated_seed?keychain=%2FUsers%2Fme%2FLibrary%2FKeychains%2Flogin.keychain-db`
- Runtime behavior: shell out to `security find-generic-password -a <account> -s <service> -w`
- Setup flow: `walleterm setup keychain`

For the macOS keychain provider:

- `service` maps to the logical Walleterm environment, typically `walleterm-testnet` or `walleterm-mainnet`
- `account` maps to a secret field name such as `delegated_seed`, `deployer_seed`, or `channels_api_key`

Current backend notes:

- Silent reads are expected. The macOS keychain normally allows the creating app to read its own items without prompting once the keychain is unlocked.
- The current backend uses the system `security` CLI, so this is best understood as OS-native encrypted storage for a user-session CLI, not as a 1Password-style approval workflow.
- If Walleterm ever needs stricter app-scoped ACLs or biometric/user-presence gates, that would require moving from the `security` CLI to a native Keychain Services integration.

## Why the abstraction is ref-based

Different stores have incompatible native models:

- 1Password uses `vault/item/field`
- macOS keychain uses `service/account`
- Bitwarden Secrets Manager is closer to project/secret ID
- Windows Credential Manager uses target-name records via Win32 credential APIs

Trying to force those into one shared vault schema would make the code worse. The clean seam is the secret reference itself.

## Future provider mapping

The current provider registry is designed so new providers can be added by:

1. choosing a scheme
2. implementing `resolve(ref)`
3. optionally adding a provider-specific `setup` command

Likely future schemes:

- `bwsm://<secret-id>`
  - Bitwarden Secrets Manager style backend
- `bwcli://<item-id>/<field>`
  - Bitwarden vault/CLI style backend
- `wincred://<target-name>`
  - Windows Credential Manager backend

Those providers do not need to change the signer or transaction code. They only need to produce the same secret values that `walleterm` already expects:

- Stellar seeds (`S...`) for delegated and external signers
- Channels API keys
- optional deployer seeds

## Setup commands

Provisioning is intentionally provider-specific.

That is because write semantics differ substantially between stores:

- 1Password can create/edit a single item with multiple fields
- macOS keychain writes separate generic-password entries
- Windows Credential Manager would likely write named generic credentials
- Bitwarden may require project/org selection and different auth flows

So the runtime API is shared, while setup/bootstrap remains backend-specific.
