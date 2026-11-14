# 0006 — The root CA key is encrypted at rest

Status: accepted

## Context

Reversee generates a root CA and asks the user to trust it system-wide, so HTTPS
clients accept the listener. Its private key was stored in plain text in
`userData/config.json`. Anything able to read that file — another process running
as the user, a backup, a synced folder — could mint certificates the machine
trusts and intercept the user's TLS traffic. That is inherent to interception
tools, but the exposure does not have to be a readable file.

## Decision

- In a **packaged app on its real profile**, the key is encrypted with Electron
  `safeStorage` (Keychain on macOS, DPAPI on Windows, the desktop keyring on Linux)
  and stored as `privateKeyEnc` under the same legacy key path (`root.cert.pem`).
  The certificate itself is unchanged, so an already-trusted root stays trusted.
- A plaintext key is migrated the first time a codec is available. If encryption
  fails, the plaintext copy is kept — losing the key would be worse.
- A stored root whose key **cannot be decrypted is never overwritten**. The session
  runs on a temporary root, `validate_setup` and the UI say so, and replacing the
  stored root is an explicit user action (_Regenerate Root Cert_).
- The keychain is **not** used when the app is unpackaged (development, e2e) or the
  profile comes from `REVERSEE_USER_DATA` (tests, throwaway headless agent
  instances): a keychain prompt there would block an unattended start. Linux's
  `basic_text` backend is treated as unavailable — it is obfuscation, not encryption.
- `config.json` is created owner-only (`0600`).

## Consequences

- The migration is **one-way**. A version older than this one cannot read
  `privateKeyEnc`, so downgrading requires regenerating the root (and trusting it
  again).
- Moving a profile to another machine, or restoring `config.json` without the
  keychain entry, leaves the key locked: the user regenerates the root.
- Development builds share the profile directory with an installed app but not its
  keychain entry, so a dev run against a migrated profile uses a temporary root.
