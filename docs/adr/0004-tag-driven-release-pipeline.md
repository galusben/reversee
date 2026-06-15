# 0004 — Tag-driven, gated release pipeline

Status: accepted

## Context

Reversee ships signed, notarized desktop binaries across macOS, Windows, and Linux,
plus a Homebrew cask and the `reversee-mcp` npm package. Hand-publishing is
error-prone and risks releasing artifacts that fail signing/notarization or
Gatekeeper. Releases need to be reproducible and to refuse to go live until the
macOS artifacts are verified.

## Decision

Releases are **driven entirely by pushing a `v*` git tag**. The pipeline (see
[RELEASING.md](../../RELEASING.md) and `.github/workflows/release.yml`) runs in gated
stages:

1. **build** — multi-platform build; macOS signed + notarized when secrets are present.
2. **verify-mac** — download the draft artifacts and validate codesign, notarization,
   and Gatekeeper, then a packaged smoke test.
3. **promote** — publish the draft as a release (latest, or prerelease for tags with a
   hyphen like `-beta.1`).
4. **homebrew** — update the cask in `galusben/homebrew-reversee` (stable releases only).

Nothing is published by hand.

## Consequences

- A release is reproducible from a tag, and nothing reaches users until macOS
  artifacts are verified.
- Pre-release tags (`-beta.1`, etc.) publish as prereleases and skip Homebrew.
- Secrets (signing/notarization, tap token) live only in CI; never in the repo.
