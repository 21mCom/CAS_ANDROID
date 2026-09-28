#!/usr/bin/env node
/**
 * check-merge-clobber.mjs — catch silently reverted work in recent git history.
 *
 * Encodes the manual sweep from task 199 (see
 * .agents/memory/concurrent-task-merge-clobber.md for the failure pattern):
 *
 *   Check 1 (blob A→B→A): flag files whose blob reverted to an older version
 *   with a different blob in between — the signature of a commit built from a
 *   stale snapshot re-imposing an old file over a concurrent task's newer one.
 *
 *   Check 2 (added-line absence): flag commits whose substantive added lines
 *   are mostly absent at HEAD, tracing sample missing lines via `git log -S`
 *   to the commit that removed them.
 *
 * Deliberate break/revert proof commits stay excludable so output remains
 * actionable:
 *   - put the marker [no-clobber-check] anywhere in the commit message, or
 *   - list the commit/path in scripts/merge-clobber-allowlist.json.
 *
 * Exit code: 0 when no unexcluded findings, 1 when findings need a look.
 * Not a git repository (or empty history) prints a warning and exits 0 so the
 * post-merge hook never bricks environment setup.
 *
 * Usage:
 *   node scripts/check-merge-clobber.mjs [--window N] [--base REF] [--head REF]
 *     [--threshold 0..1] [--min-lines N] [--trace-limit N]
 *     [--allowlist PATH | --no-allowlist] [--repo DIR] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const IGNORE_MARKER = "[no-clobber-check]";
const DEFAULT_IGNORED_PATHS = [
  "pnpm-lock.yaml",
  "**/pnpm-lock.yaml",
  "*.tsbuildinfo",
  "**/*.tsbuildinfo",
  // Agent memory churns constantly (index lines reworded, topic files
  // renamed); a stale-snapshot clobber there is low-stakes and self-healing,
  // and the noise would drown real findings.
  ".agents/memory/**",
];
const DEFAULT_ALLOWLIST = "scripts/merge-clobber-allowlist.json";

function parseArgs(argv) {
  const options = {
    window: 60,
    base: null,
    head: "HEAD",
    threshold: 0.6,
    minLines: 5,
    traceLimit: 5,
    allowlist: undefined, // undefined => default path if it exists
    repo: process.cwd(),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case "--window":
        options.window = Number.parseInt(next(), 10);
        break;
      case "--base":
        options.base = next();
        break;
      case "--head":
        options.head = next();
        break;
      case "--threshold":
        options.threshold = Number.parseFloat(next());
        break;
      case "--min-lines":
        options.minLines = Number.parseInt(next(), 10);
        break;
      case "--trace-limit":
        options.traceLimit = Number.parseInt(next(), 10);
        break;
      case "--allowlist":
        options.allowlist = next();
        break;
      case "--no-allowlist":
        options.allowlist = null;
        break;
      case "--repo":
        options.repo = resolve(next());
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/check-merge-clobber.mjs [--window N] [--base REF] [--head REF] [--threshold F] [--min-lines N] [--trace-limit N] [--allowlist PATH|--no-allowlist] [--repo DIR] [--json]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.window) || options.window < 1) {
    throw new Error("--window must be a positive integer");
  }
  if (!(options.threshold > 0 && options.threshold <= 1)) {
    throw new Error("--threshold must be in (0, 1]");
  }
  return options;
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function shaMatches(sha, prefix) {
  if (!prefix) return false;
  const p = String(prefix).trim();
  if (p.length < 7) return false;
  return sha.startsWith(p) || p.startsWith(sha);
}

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

function loadAllowlist(options) {
  const empty = { commits: {}, paths: {}, reversions: [] };
  let path = options.allowlist;
  if (path === null) return empty;
  if (path === undefined) path = join(options.repo, DEFAULT_ALLOWLIST);
  if (!existsSync(path)) return empty;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    commits: parsed.commits ?? {},
    paths: parsed.paths ?? {},
    reversions: Array.isArray(parsed.reversions) ? parsed.reversions : [],
  };
}

function makeExcluders(options, allowlist) {
  const ignoredPathRes = [...DEFAULT_IGNORED_PATHS, ...Object.keys(allowlist.paths ?? {})].map(globToRegExp);
  const isIgnoredPath = (path) => ignoredPathRes.some((re) => re.test(path));
  const commitReason = (commit) => {
    if (commit.message.includes(IGNORE_MARKER)) {
      return `commit message carries the ${IGNORE_MARKER} marker`;
    }
    for (const [prefix, reason] of Object.entries(allowlist.commits ?? {})) {
      if (shaMatches(commit.sha, prefix)) return `allowlisted commit: ${reason}`;
    }
    return null;
  };
  const reversionReason = (commit, path) => {
    const byCommit = commitReason(commit);
    if (byCommit) return byCommit;
    if (Object.keys(allowlist.paths ?? {}).some((glob) => globToRegExp(glob).test(path))) {
      return "allowlisted path";
    }
    for (const entry of allowlist.reversions ?? []) {
      const pathOk = !entry.path || globToRegExp(entry.path).test(path);
      const byOk = !entry.by || shaMatches(commit.sha, entry.by);
      if (pathOk && byOk) return `allowlisted reversion: ${entry.reason ?? "no reason given"}`;
    }
    return null;
  };
  return { isIgnoredPath, commitReason, reversionReason };
}

// --- History loading -------------------------------------------------------

function listWindowCommits(options) {
  const range = options.base ? `${options.base}..${options.head}` : `-${options.window}`;
  const args = options.base
    ? ["log", "--format=%x1e%H%x00%P%x00%B", range]
    : ["log", "--format=%x1e%H%x00%P%x00%B", range, options.head];
  const out = git(options.repo, args);
  const commits = [];
  for (const record of out.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [sha, parents, ...messageParts] = trimmed.split("\x00");
    if (!sha) continue;
    commits.push({
      sha: sha.trim(),
      parents: (parents ?? "").trim().split(/\s+/).filter(Boolean),
      message: messageParts.join("\x00"),
      subject: messageParts.join("\x00").split("\n")[0] ?? "",
    });
  }
  return commits; // newest first
}

// --- Check 1: blob A→B→A reversions ---------------------------------------

function detectBlobReversions(options, commits) {
  const args = options.base
    ? ["log", "--raw", "--no-abbrev", "--format=%x1e%H", `${options.base}..${options.head}`]
    : ["log", "--raw", "--no-abbrev", "--format=%x1e%H", `-${options.window}`, options.head];
  const out = git(options.repo, args);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  // timelines: path -> [{ sha, blob }] in oldest→newest order (null blob = deleted)
  const timelines = new Map();
  let currentSha = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\x1e")) {
      currentSha = line.slice(1).trim();
      continue;
    }
    if (!line.startsWith(":") || !currentSha) continue;
    const tabSplit = line.split("\t");
    const meta = tabSplit[0].split(" ");
    if (meta.length < 5) continue;
    const newBlob = meta[3];
    const status = meta[4][0];
    if (status === "R" || status === "C") continue; // skip renames/copies
    const path = tabSplit[tabSplit.length - 1];
    if (!path) continue;
    if (!timelines.has(path)) timelines.set(path, []);
    timelines.get(path).push({
      sha: currentSha,
      blob: status === "D" ? null : newBlob,
    });
  }

  const findings = [];
  for (const [path, entriesNewestFirst] of timelines) {
    const entries = entriesNewestFirst.toReversed(); // oldest → newest
    // newest reversion: latest j whose blob equals some earlier blob with a
    // different blob strictly in between (deletion counts as different).
    for (let j = entries.length - 1; j >= 1; j -= 1) {
      const current = entries[j];
      if (current.blob === null) continue;
      let hit = null;
      for (let i = j - 1; i >= 0; i -= 1) {
        if (entries[i].blob === current.blob) {
          const differsBetween = entries.slice(i + 1, j).some((e) => e.blob !== current.blob);
          if (differsBetween) {
            const discarded = entries.slice(i + 1, j).find((e) => e.blob !== current.blob);
            hit = { restoredFrom: entries[i], discarded };
          }
          break; // only compare against the most recent matching ancestor
        }
      }
      if (hit) {
        findings.push({
          path,
          revertedBy: bySha.get(current.sha) ?? { sha: current.sha, subject: "(outside window)" },
          restoresContentFrom: bySha.get(hit.restoredFrom.sha) ?? { sha: hit.restoredFrom.sha, subject: "(outside window)" },
          discardsChangeFrom: bySha.get(hit.discarded.sha) ?? { sha: hit.discarded.sha, subject: "(outside window)" },
        });
        // keep scanning earlier entries: a path can be reverted more than once
      }
    }
  }
  return findings;
}

// --- Check 2: added lines mostly absent at HEAD ----------------------------

function isSubstantiveLine(line) {
  const t = line.trim();
  if (t.length < 8) return false;
  if (!/[A-Za-z0-9]/.test(t)) return false;
  if (/^[\s{}()[\];,.:'"`]*$/.test(t)) return false;
  return true;
}

function collectAddedLines(options, commit) {
  const out = git(options.repo, [
    "diff-tree", "--root", "-r", "-U0", "--no-commit-id", "--no-renames", commit.sha,
  ]);
  const added = new Map(); // path -> Set of trimmed substantive lines
  let currentPath = null;
  let currentBinary = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("Binary files ")) {
      currentBinary = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentPath = target.startsWith("b/") ? target.slice(2) : target;
      currentBinary = false;
      if (currentPath === "/dev/null") currentPath = null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++") && currentPath && !currentBinary) {
      const content = line.slice(1);
      if (isSubstantiveLine(content)) {
        if (!added.has(currentPath)) added.set(currentPath, new Set());
        added.get(currentPath).add(content.trim());
      }
    }
  }
  return added;
}

function headLineSet(options, path, cache) {
  if (cache.has(path)) return cache.get(path);
  const content = git(options.repo, ["show", `${options.head}:${path}`], { allowFailure: true });
  const set = content === null ? null : new Set(content.split("\n").map((l) => l.trim()));
  cache.set(path, set);
  return set;
}

function traceRemoval(options, path, line) {
  const out = git(options.repo, [
    "log", "-n", "1", "--format=%h%x00%s", `-S${line}`, options.head, "--", path,
  ], { allowFailure: true });
  if (!out || !out.trim()) return null;
  const [short, subject] = out.trim().split("\x00");
  return { commit: short, subject };
}

function detectAddedLineGaps(options, commits, excluders) {
  const headCache = new Map();
  const findings = [];
  for (const commit of commits) {
    if (commit.parents.length > 1) continue; // merge diffs are covered by their parents
    if (excluders.commitReason(commit)) continue;
    const added = collectAddedLines(options, commit);
    let total = 0;
    let missing = 0;
    const files = [];
    for (const [path, lines] of added) {
      if (excluders.isIgnoredPath(path)) continue;
      const headLines = headLineSet(options, path, headCache);
      const missingLines = headLines === null
        ? [...lines]
        : [...lines].filter((l) => !headLines.has(l));
      total += lines.size;
      missing += missingLines.length;
      if (missingLines.length > 0) {
        files.push({ path, total: lines.size, missing: missingLines.length, missingLines, deletedAtHead: headLines === null });
      }
    }
    if (total < options.minLines) continue;
    if (missing / total < options.threshold) continue;
    let traced = 0;
    for (const file of files) {
      file.traces = [];
      for (const line of file.missingLines) {
        if (traced >= options.traceLimit) break;
        const removal = traceRemoval(options, file.path, line);
        if (removal) {
          file.traces.push({ line: line.length > 100 ? `${line.slice(0, 97)}...` : line, removedBy: removal });
          traced += 1;
        }
      }
      delete file.missingLines;
    }
    findings.push({ commit, total, missing, files });
  }
  return findings;
}

// --- Report ---------------------------------------------------------------

function short(sha) {
  return sha.slice(0, 7);
}

function printReport(result) {
  const lines = [];
  lines.push(`Merge-clobber check: ${result.scannedCommits} commits ending at ${short(result.head)} (${result.headSubject})`);
  lines.push("");
  if (result.findings.blobReversions.length > 0) {
    lines.push("Blob reversions (file content reverted to an older blob with a different blob in between):");
    for (const f of result.findings.blobReversions) {
      lines.push(`  ${f.path}`);
      lines.push(`    reverted by:  ${short(f.revertedBy.sha)} ${f.revertedBy.subject}`);
      lines.push(`    restores:     ${short(f.restoresContentFrom.sha)} ${f.restoresContentFrom.subject}`);
      lines.push(`    discards:     ${short(f.discardsChangeFrom.sha)} ${f.discardsChangeFrom.subject}`);
    }
    lines.push("");
  }
  if (result.findings.addedLineGaps.length > 0) {
    lines.push("Commits whose added lines are mostly absent at HEAD:");
    for (const f of result.findings.addedLineGaps) {
      lines.push(`  ${short(f.commit.sha)} ${f.commit.subject}`);
      lines.push(`    ${f.missing}/${f.total} substantive added lines absent at HEAD`);
      for (const file of f.files) {
        lines.push(`    ${file.path}: ${file.missing}/${file.total} missing${file.deletedAtHead ? " (file gone at HEAD)" : ""}`);
        for (const trace of file.traces ?? []) {
          lines.push(`      "${trace.line}" removed by ${trace.removedBy.commit} ${trace.removedBy.subject}`);
        }
      }
    }
    lines.push("");
  }
  if (result.excluded.length > 0) {
    lines.push(`Excluded as deliberate (${result.excluded.length}):`);
    for (const e of result.excluded) lines.push(`  ${e} `);
    lines.push("");
  }
  if (result.ok) {
    lines.push("RESULT: CLEAN — no unexcluded signs of silently reverted work.");
    lines.push(`(Deliberate reverts/break-proofs: add ${IGNORE_MARKER} to the commit message or extend ${DEFAULT_ALLOWLIST}.)`);
  } else {
    lines.push("RESULT: FINDINGS — investigate before trusting the current tree.");
    lines.push(`If a finding is a deliberate revert/break-proof, re-run after adding ${IGNORE_MARKER} to that commit's message or an entry in ${DEFAULT_ALLOWLIST}.`);
  }
  console.log(lines.join("\n"));
}

// --- Main -------------------------------------------------------------------

export function runCheck(options) {
  const isRepo = git(options.repo, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (isRepo === null || isRepo.trim() !== "true") {
    return { ok: true, skipped: true, reason: "not a git repository", findings: { blobReversions: [], addedLineGaps: [] }, excluded: [] };
  }
  const allowlist = loadAllowlist(options);
  const excluders = makeExcluders(options, allowlist);
  const commits = listWindowCommits(options);
  if (commits.length === 0) {
    return { ok: true, skipped: true, reason: "empty window", findings: { blobReversions: [], addedLineGaps: [] }, excluded: [] };
  }
  const head = git(options.repo, ["rev-parse", options.head]).trim();
  const headSubject = git(options.repo, ["log", "-n", "1", "--format=%s", options.head]).trim();

  const excluded = [];
  const blobReversions = [];
  for (const f of detectBlobReversions(options, commits)) {
    if (excluders.isIgnoredPath(f.path)) continue;
    const reason = excluders.reversionReason(f.revertedBy, f.path);
    if (reason) {
      excluded.push(`${f.path} reverted by ${short(f.revertedBy.sha)} (${reason})`);
    } else {
      blobReversions.push(f);
    }
  }
  const addedLineGaps = detectAddedLineGaps(options, commits, excluders);

  return {
    ok: blobReversions.length === 0 && addedLineGaps.length === 0,
    head,
    headSubject,
    scannedCommits: commits.length,
    findings: { blobReversions, addedLineGaps },
    excluded,
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runCheck(options);
    if (result.skipped) {
      console.warn(`check-merge-clobber: skipped (${result.reason}).`);
      process.exit(0);
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`check-merge-clobber: ${error.message}`);
    process.exit(2);
  }
}
