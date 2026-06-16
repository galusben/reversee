# 0001 — Electron-free proxy core

Status: accepted

## Context

The reverse-proxy logic (listening, forwarding, decompression, interceptors,
breakpoints) is the heart of the app and the part most in need of fast, thorough
testing. Electron is heavy to spin up and couples code to a desktop runtime, which
makes pure logic slow and awkward to test and impossible to reuse headlessly.

## Decision

Keep `src/proxy/core/` as **plain Node with no Electron imports**, and run it in a
`utilityProcess` worker (`src/proxy/worker.ts`) that communicates with main over
typed `parentPort` messages. An **ESLint rule forbids Electron imports** in the
proxy core so the boundary can't erode.

## Consequences

- The core can be unit/integration-tested without launching Electron (fast CI).
- The worker is disposable: a wedged interceptor or crash is recovered by killing
  and respawning the `utilityProcess` (`restart_proxy`), with no state in the worker.
- New proxy behavior must stay Electron-free; anything needing Electron belongs in
  `src/main/` and is reached through worker messages
  ([architecture.md](../architecture.md)).
