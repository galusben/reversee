#!/usr/bin/env node
// Guards the coupling between the app and the reversee-mcp bridge.
//
// The app hardcodes RECOMMENDED_BRIDGE_VERSION (src/main/mcp/catalog.ts) and
// nags every user whose bridge is older. Users upgrade with `npx -y
// reversee-mcp`, which can only give them what npm has — so recommending a
// version that was never published makes the advisory unsatisfiable.
//
// Two halves:
//   1. offline — the recommendation must not exceed mcp/package.json.
//      Also asserted in tests/unit/mcp-catalog.test.mjs, so CI catches it.
//   2. online  — the recommended version must exist on the registry.
//      Needs network, which is why it lives here and not in the unit suite.
//
// Usage:
//   node scripts/check-bridge-version.mjs          # both halves
//   node scripts/check-bridge-version.mjs --offline  # skip the registry call
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

/** The constant is a plain string literal; parse it rather than importing TS. */
export function readRecommendedBridgeVersion(source = read('src/main/mcp/catalog.ts')) {
  const m = source.match(/export const RECOMMENDED_BRIDGE_VERSION = '([^']+)'/);
  if (!m) throw new Error('RECOMMENDED_BRIDGE_VERSION not found in src/main/mcp/catalog.ts');
  return m[1];
}

const core = (v) =>
  v
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);

/** True when a > b, comparing release cores numerically. */
export function isNewerVersion(a, b) {
  const [a0 = 0, a1 = 0, a2 = 0] = core(a);
  const [b0 = 0, b1 = 0, b2 = 0] = core(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

function main() {
  const offline = process.argv.includes('--offline');
  const recommended = readRecommendedBridgeVersion();
  const packaged = JSON.parse(read('mcp/package.json')).version;
  const problems = [];

  if (isNewerVersion(recommended, packaged)) {
    problems.push(
      `RECOMMENDED_BRIDGE_VERSION (${recommended}) is newer than mcp/package.json (${packaged}).\n` +
        `  The app would recommend a bridge this repo cannot even build.`
    );
  }

  if (!offline) {
    let published = '';
    try {
      published = execFileSync('npm', ['view', `reversee-mcp@${recommended}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      published = '';
    }
    if (published !== recommended) {
      let latest = '(unknown)';
      try {
        latest = execFileSync('npm', ['view', 'reversee-mcp', 'version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch {
        /* registry unreachable; the message below still says what is wrong */
      }
      problems.push(
        `reversee-mcp@${recommended} is not on npm (latest published: ${latest}).\n` +
          `  Every user would be told to upgrade to a version they cannot install.\n` +
          `  Publish it from mcp/ — see the "MCP bridge" section of RELEASING.md.`
      );
    }
  }

  if (problems.length) {
    console.error('Bridge version check FAILED:\n');
    for (const p of problems) console.error(`- ${p}\n`);
    process.exit(1);
  }

  console.log(
    `Bridge version OK: app recommends ${recommended}, mcp/package.json is ${packaged}` +
      (offline ? ' (registry check skipped)' : ', and that version is published on npm')
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
