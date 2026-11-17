#!/usr/bin/env node
// Prints the failures recorded by the last `npm test` run (the JSON report
// vitest.config.mjs writes): test file, full test name, duration, and the
// complete failure message with its stack — no rerun needed.
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'test-results/vitest/results.json');
if (!fs.existsSync(file)) {
  console.error(`No unit test report at ${file}. Run npm test first.`);
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const when = new Date(report.startTime).toISOString();
console.log(
  `Run of ${when}: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ` +
    `${report.numFailedTestSuites} failed file(s).`
);

let shown = 0;
for (const suite of report.testResults) {
  const rel = path.relative(process.cwd(), suite.name);
  // A file that failed to load or crashed has no assertion results, only a message.
  if (suite.status === 'failed' && suite.message && !suite.assertionResults.length) {
    shown++;
    console.log(`\n✗ ${rel} (whole file)\n${suite.message}`);
  }
  for (const test of suite.assertionResults) {
    if (test.status !== 'failed') continue;
    shown++;
    console.log(`\n✗ ${rel} › ${test.fullName}  (${Math.round(test.duration ?? 0)} ms)`);
    for (const message of test.failureMessages) console.log(message);
  }
}
process.exit(shown ? 1 : 0);
