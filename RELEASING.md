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

Four gated stages — nothing reaches users until the signed macOS app has been verified:

1. **build** (macOS, Windows, Linux) — `electron-builder` builds each platform, signs and notarizes the macOS app, and publishes the artifacts to a **draft** GitHub release.
2. **verify-mac** — downloads the signed `.dmg`/`.zip` from the draft, checks the code signature, notarization staple, and Gatekeeper acceptance, then installs the app and runs a smoke test against the **real packaged binary** (window loads, preload API present, version matches the tag).
3. **publish-bridge** — publishes the `reversee-mcp` npm package if its version is not on the registry yet, then asserts the shipping app's bridge recommendation is satisfiable. See [The MCP bridge](#the-mcp-bridge-reversee-mcp) below.
4. **promote** — publishes the release (marks it `latest`) and updates the [Homebrew cask](https://github.com/galusben/homebrew-reversee) with the new version and per-architecture checksums.

If any check fails the release stays a draft and users are unaffected.

## The MCP bridge (`reversee-mcp`)

The app is not the only thing that ships. `mcp/` is a **separate npm package**,
versioned independently of the app, and MCP clients run it straight from the
registry (`npx -y reversee-mcp`). It is easy to forget, and forgetting it breaks
users in a way nothing else in this repo does.

**The coupling.** `src/main/mcp/catalog.ts` hardcodes
`RECOMMENDED_BRIDGE_VERSION`. The bridge reports its own version during the
control-socket handshake, and the app puts an upgrade advisory into every
`get_status` when the bridge is older. That is deliberate: since 2.1.0 the
bridge is a generic passthrough that serves the **app-owned** tool catalog, so
new tools reach users without a bridge release — but only if they are actually
on a 2.1.0+ bridge. The advisory is how they get pulled forward.

**The invariant.**

> `RECOMMENDED_BRIDGE_VERSION` must never exceed the highest `reversee-mcp`
> version **published to npm**.

Users upgrade with `npx -y reversee-mcp`, which can only ever hand them what the
registry has. Point the constant at an unpublished version and every user is
told, on every `get_status`, to upgrade to something that does not exist — and
following the instructions changes nothing. Bumping `mcp/package.json` is **not**
publishing; the two are separate acts.

**What enforces it.**

| Check                               | Where                                 | Catches                                               |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `npm test` (`mcp-catalog.test.mjs`) | every PR                              | constant newer than `mcp/package.json` (offline)      |
| `npm run check:bridge-version`      | by hand, and the `publish-bridge` job | constant not published to npm (hits the registry)     |
| `publish-bridge`                    | release pipeline, gates `promote`     | a tagged release whose app points at a missing bridge |

**Releasing a bridge change.** Bump `mcp/package.json`, and bump
`RECOMMENDED_BRIDGE_VERSION` to match only if you want to pull users onto it.
The release pipeline publishes it on the next tag. To publish by hand instead:

```sh
npm run build:mcp
npm publish -w reversee-mcp --access public
npm run check:bridge-version -- --wait   # confirms the invariant now holds
```

`--wait` matters straight after a publish: npm returns success before the
version is readable ("your package is being processed and may take a few minutes
to become available"), so a single read races propagation. Without the flag the
check fails fast, which is what you want when verifying the invariant by hand.

Bridge versions are independent of app versions — they only happen to have
tracked each other so far. Publishing is idempotent in the pipeline: if that
version is already on npm, the job says so and moves on.

**Pre-release tags skip it entirely.** An npm publish is public and permanent
(unpublish is limited to 72 hours), so a `-beta` rehearsal must not perform one.
`publish-bridge` is therefore guarded like the Homebrew job, and `promote` is
written to tolerate it being skipped. The trade-off is that a rehearsal does not
exercise the publish path — the first real run of it is a stable tag.

## Where releases go

- **GitHub Releases** — the canonical download and the auto-update feed (`electron-updater`, GitHub provider). Installed apps update themselves from here.
- **Homebrew** — `brew install --cask galusben/reversee/reversee`, updated automatically by the pipeline.
- **`install.sh`** — the `curl | bash` one-liner always resolves the latest GitHub release.

## Required secrets

Configured on the `reversee` repo (Settings → Secrets → Actions):

| Secret                                                     | Purpose                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | macOS Developer ID signing certificate (.p12, base64) and its password           |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with Apple's notary service                                         |
| `TAP_GITHUB_TOKEN`                                         | Fine-grained PAT with Contents:write on `homebrew-reversee`, for the cask update |

Missing signing secrets → unsigned build; missing `TAP_GITHUB_TOKEN` → the Homebrew step is skipped. The build still succeeds either way.

**npm needs no secret.** The bridge is published through [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers): the `publish-bridge` job
requests a short-lived OIDC token (`permissions: id-token: write`) and npm
exchanges it for publish rights scoped to this repo and workflow. There is no
long-lived credential to leak, rotate or expire, and each tarball gets a
provenance attestation tying it to the commit and run that built it.

Configured at npmjs.com → `reversee-mcp` → Settings → Trusted Publisher, as
GitHub Actions / `galusben/reversee` / `release.yml`. If that configuration is
missing or the workflow filename changes, the publish fails with an
authentication error — the fix is on npmjs.com, not in the repo.

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
