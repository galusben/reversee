# Releasing Reversee

Releases are fully automated. To ship a version you bump the version and push a tag — CI builds, signs, notarizes, verifies, publishes, and updates Homebrew.

## Cut a release

```sh
# 1. bump the version in package.json (e.g. 2.1.0), commit, merge to main
# 2. tag main and push the tag
git checkout main && git pull
git tag v2.1.0
git push origin v2.1.0
```

That's it. The tag triggers `.github/workflows/release.yml`.

Use a pre-release tag (`v2.1.0-beta.1`) to rehearse the whole pipeline safely: it publishes as a GitHub **pre-release** (not marked `latest`) and the Homebrew cask is **not** updated. Stable tags (no hyphen) become `latest` and update the cask.

## What the pipeline does

Three gated stages — nothing reaches users until the signed macOS app has been verified:

1. **build** (macOS, Windows, Linux) — `electron-builder` builds each platform, signs and notarizes the macOS app, and publishes the artifacts to a **draft** GitHub release.
2. **verify-mac** — downloads the signed `.dmg`/`.zip` from the draft, checks the code signature, notarization staple, and Gatekeeper acceptance, then installs the app and runs a smoke test against the **real packaged binary** (window loads, preload API present, version matches the tag).
3. **promote** — publishes the release (marks it `latest`) and updates the [Homebrew cask](https://github.com/galusben/homebrew-reversee) with the new version and per-architecture checksums.

If any check fails the release stays a draft and users are unaffected.

## Where releases go

- **GitHub Releases** — the canonical download and the auto-update feed (`electron-updater`, GitHub provider). Installed apps update themselves from here.
- **Homebrew** — `brew install --cask galusben/reversee/reversee`, updated automatically by the pipeline.
- **`install.sh`** — the `curl | bash` one-liner always resolves the latest GitHub release.

## Required secrets

Configured on the `reversee` repo (Settings → Secrets → Actions):

| Secret | Purpose |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID signing certificate (.p12, base64) and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with Apple's notary service |
| `TAP_GITHUB_TOKEN` | Fine-grained PAT with Contents:write on `homebrew-reversee`, for the cask update |

Missing signing secrets → unsigned build; missing `TAP_GITHUB_TOKEN` → the Homebrew step is skipped. The build still succeeds either way.

## Verifying a published macOS build by hand

```sh
codesign -dv --verbose=4 /Applications/Reversee.app      # TeamIdentifier=7S36FB2PXQ
xcrun stapler validate /Applications/Reversee.app        # "The validate action worked!"
spctl -a -t exec -vvv /Applications/Reversee.app         # source=Notarized Developer ID
```

## Legacy S3 channel (one-time)

Apps from before 2.0 auto-updated from an S3 feed (`download.reversee.ninja`). A one-time 2.0.0 build was published there so those users get pulled onto the GitHub channel; **S3 is not part of the regular release flow**. If you ever need to refresh it, upload the artifacts and the three `latest-*.yml` files to the `reverseeapp` bucket with `--acl public-read` (the mac feed must point at the x64 `-mac.zip`, which the pre-arm64 updater expects).

## Notes

- The version in `package.json` must match the tag (minus the `v`); the smoke test asserts this.
- Pre-release tags (containing a hyphen, e.g. `-beta.1`) publish as a GitHub pre-release, are not marked `latest`, and do not touch Homebrew.
