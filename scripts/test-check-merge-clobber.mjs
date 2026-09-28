#!/usr/bin/env node
/**
 * test-check-merge-clobber.mjs — prove the merge-clobber checker catches a
 * synthetic stale-snapshot clobber, traces removed lines to the removing
 * commit, and stays quiet for marker/allowlist-excluded deliberate reverts.
 *
 * Fixture history (oldest → newest):
 *   c1  add src/core.ts (v1) + notes.txt
 *   c2  core.ts → v2
 *   c3  core.ts → v1        <- silent clobber (A→B→A, unmarked)
 *   c4  add src/feature.ts (10 substantive lines)
 *   c5  feature.ts keeps only 2 of c4's lines  <- stale snapshot wipe
 *   c6  notes.txt changed
 *   c7  notes.txt reverted, message carries [no-clobber-check]
 *   c8  core.ts → v3
 *   c9  core.ts → v2        <- deliberate unmarked reversion, allowlisted in run 2
 *
 * Run 1 expects exit 1 with: blob reversions for c3 and c9 (not c7), an
 * added-line gap for c4 traced to c5, and gap flags for c1/c3/c8 (their
 * lines are gone at HEAD = v2).
 * Run 2 allowlists commits c1/c3/c4/c8 and the c9 reversion → exit 0.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const checkerPath = join(dirname(fileURLToPath(import.meta.url)), "check-merge-clobber.mjs");
const repo = mkdtempSync(join(tmpdir(), "clobber-fixture-"));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};
const git = (args) => execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
const write = (rel, content) => {
  mkdirSync(join(repo, dirname(rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
};
const commit = (message) => {
  git(["add", "-A"]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
};

const vLines = (tag) =>
  Array.from({ length: 10 }, (_, i) => `export const ${tag}Line${i} = "${tag}-value-${i}";`).join("\n") + "\n";

git(["init", "-q", "-b", "main"]);
write("src/core.ts", vLines("v1"));
write("notes.txt", "hello note\n");
const c1 = commit("Add core v1 and notes");
write("src/core.ts", vLines("v2"));
commit("Update core to v2");
const c3 = (write("src/core.ts", vLines("v1")), commit("Silent clobber back to v1"));
write("src/feature.ts", Array.from({ length: 10 }, (_, i) => `export function featureHelper${i}() { return ${i}; }`).join("\n") + "\n");
const c4 = commit("Add feature helpers");
write("src/feature.ts", "export function featureHelper0() { return 0; }\nexport function featureHelper1() { return 1; }\nexport function replacement() { return true; }\n");
const c5 = commit("Stale snapshot rewrites feature helpers");
write("notes.txt", "changed note\n");
commit("Change notes");
const c7 = (write("notes.txt", "hello note\n"), commit("Restore notes on purpose [no-clobber-check]"));
write("src/core.ts", vLines("v3"));
const c8 = commit("Update core to v3");
const c9 = (write("src/core.ts", vLines("v2")), commit("Deliberate revert to v2"));

function runChecker(extraArgs) {
  try {
    const out = execFileSync(process.execPath, [checkerPath, "--repo", repo, "--window", "20", "--json", ...extraArgs], { encoding: "utf8" });
    return { exitCode: 0, result: JSON.parse(out) };
  } catch (error) {
    if (typeof error.status === "number" && error.stdout) {
      return { exitCode: error.status, result: JSON.parse(error.stdout) };
    }
    throw error;
  }
}

// --- Run 1: findings expected ---------------------------------------------
const run1 = runChecker([]);
assert.equal(run1.exitCode, 1, "run 1 must exit 1 with findings");
const { blobReversions, addedLineGaps } = run1.result.findings;

const revertedBySha = (sha) => blobReversions.filter((f) => f.revertedBy.sha === sha);
assert.equal(revertedBySha(c3).length, 1, "c3 clobber of core.ts must be flagged");
assert.equal(revertedBySha(c3)[0].path, "src/core.ts");
assert.equal(revertedBySha(c3)[0].restoresContentFrom.sha, c1, "c3 restores the c1 blob");
assert.equal(revertedBySha(c9).length, 1, "c9 reversion of core.ts must be flagged before allowlisting");
assert.equal(revertedBySha(c7).length, 0, "marker commit c7 must not be flagged");

const gapFor = (sha) => addedLineGaps.find((f) => f.commit.sha === sha);
const c4Gap = gapFor(c4);
assert.ok(c4Gap, "c4 must be flagged: most of its added lines are gone at HEAD");
const featureFile = c4Gap.files.find((f) => f.path === "src/feature.ts");
assert.ok(featureFile, "c4 gap must name src/feature.ts");
assert.equal(featureFile.missing, 8, "8 of 10 feature lines vanished");
assert.ok(
  featureFile.traces.some((t) => t.removedBy.commit === c5.slice(0, 7)),
  "a missing feature line must trace to c5 via git log -S",
);
for (const sha of [c1, c3, c8]) {
  assert.ok(gapFor(sha), `${sha.slice(0, 7)} lines are gone at HEAD and must be flagged`);
}
assert.ok(!gapFor(c5), "c5's surviving lines are still present at HEAD");
assert.ok(!gapFor(c7), "marker commit c7 must be skipped in the added-line check too");

// --- Run 2: allowlist suppresses everything --------------------------------
const allowlistPath = join(repo, "fixture-allowlist.json");
writeFileSync(allowlistPath, JSON.stringify({
  commits: {
    [c1.slice(0, 12)]: "fixture setup commit",
    [c3.slice(0, 12)]: "deliberate clobber, proven caught by run 1",
    [c4.slice(0, 12)]: "feature intentionally removed in c5",
    [c8.slice(0, 12)]: "v3 intentionally replaced by v2",
  },
  reversions: [{ path: "src/core.ts", by: c9.slice(0, 12), reason: "deliberate fixture revert" }],
}));
const run2 = runChecker(["--allowlist", allowlistPath]);
assert.equal(run2.exitCode, 0, "run 2 must exit 0 once findings are allowlisted");
assert.equal(run2.result.findings.blobReversions.length, 0);
assert.equal(run2.result.findings.addedLineGaps.length, 0);
assert.ok(run2.result.excluded.length >= 2, "excluded findings must be listed for transparency");

console.log("Merge-clobber checker self-test passed: clobber flagged + traced, marker and allowlist exclusions honored.");
