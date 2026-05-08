#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    base: "HEAD",
    testCmd: null,
    noTests: false,
    maxDiffChars: 120000,
    maxFileChars: 20000,
    maxFiles: 20
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      options.repo = argv[++i];
    } else if (arg === "--base") {
      options.base = argv[++i];
    } else if (arg === "--test-cmd") {
      options.testCmd = argv[++i];
    } else if (arg === "--no-tests") {
      options.noTests = true;
    } else if (arg === "--max-diff-chars") {
      options.maxDiffChars = Number(argv[++i]);
    } else if (arg === "--max-file-chars") {
      options.maxFileChars = Number(argv[++i]);
    } else if (arg === "--max-files") {
      options.maxFiles = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/collect-review-context.js [options]

Options:
  --repo <path>             Repository or subdirectory to inspect. Defaults to cwd.
  --base <ref>              Diff base ref. Defaults to HEAD.
  --test-cmd "<command>"    Test command to run from the repository root.
  --no-tests                Skip test execution.
  --max-diff-chars <n>      Truncate full diff after n characters. Defaults to 120000.
  --max-file-chars <n>      Truncate each current file snapshot after n chars. Defaults to 20000.
  --max-files <n>           Max changed text files to snapshot. Defaults to 20.
`);
}

function run(command, args, cwd, useShell = false) {
  const result = useShell
    ? spawnSync(command, {
        cwd,
        shell: true,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      })
    : spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      });

  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : ""
  };
}

function runGit(args, cwd) {
  return run("git", ["-c", "core.autocrlf=false", ...args], cwd);
}

function commandBlock(command, result) {
  const output = [result.stdout.trim(), result.stderr.trim(), result.error.trim()]
    .filter(Boolean)
    .join("\n");
  const body = output || "(no output)";
  return `Command: ${command}
Exit code: ${result.status}

\`\`\`text
${body}
\`\`\``;
}

function truncate(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}

[diff truncated: ${omitted} characters omitted; rerun with --max-diff-chars for a larger context]`;
}

function parseChangedFiles(nameStatusOutput) {
  return nameStatusOutput
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+/);
      const status = parts[0];
      const filePath = parts[parts.length - 1];
      return { status, filePath };
    })
    .filter(change => change.filePath && change.status !== "D");
}

function looksTextLike(filePath) {
  const allowedExtensions = new Set([
    ".cjs", ".css", ".csv", ".env", ".go", ".html", ".java", ".js", ".json",
    ".jsx", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx",
    ".txt", ".xml", ".yaml", ".yml"
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return allowedExtensions.has(ext) || path.basename(filePath).includes(".");
}

function readNumberedFile(repoRoot, filePath, maxChars) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativeRoot = path.relative(repoRoot, absolutePath);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    return "(skipped: file is outside repository)";
  }
  if (!fs.existsSync(absolutePath)) {
    return "(skipped: file does not exist in working tree)";
  }
  if (!looksTextLike(filePath)) {
    return "(skipped: file type is likely binary or not useful for line-number review)";
  }

  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) {
    return "(skipped: binary file)";
  }

  const text = buffer.toString("utf8");
  const numbered = text
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
  return truncate(numbered, maxChars);
}

function buildFileSnapshots(repoRoot, nameStatusOutput, options) {
  const changes = parseChangedFiles(nameStatusOutput).slice(0, options.maxFiles);
  if (changes.length === 0) {
    return "No changed text files to snapshot.";
  }

  const snapshots = changes.map(change => {
    const numbered = readNumberedFile(repoRoot, change.filePath, options.maxFileChars);
    return `### ${change.status} ${change.filePath}

\`\`\`text
${numbered}
\`\`\``;
  });

  const omitted = parseChangedFiles(nameStatusOutput).length - changes.length;
  if (omitted > 0) {
    snapshots.push(`(${omitted} changed files omitted by --max-files)`);
  }
  return snapshots.join("\n\n");
}

function parseNodeTestSummary(output) {
  const summary = {};
  const patterns = {
    tests: /[ℹ#]\s*tests\s+(\d+)/i,
    pass: /[ℹ#]\s*(?:pass|passed)\s+(\d+)/i,
    fail: /[ℹ#]\s*(?:fail|failed)\s+(\d+)/i,
    skipped: /[ℹ#]\s*(?:skipped|skip)\s+(\d+)/i,
    todo: /[ℹ#]\s*todo\s+(\d+)/i
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = output.match(pattern);
    if (match) {
      summary[key] = Number(match[1]);
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function buildParsedTestSummary(testResult) {
  if (!testResult) {
    return "No test command was provided or detected.";
  }

  const combined = `${testResult.stdout}\n${testResult.stderr}`;
  const nodeSummary = parseNodeTestSummary(combined);
  if (!nodeSummary) {
    return "No structured test summary was parsed. Use the raw Test Result section as evidence.";
  }

  const skipped = typeof nodeSummary.skipped === "number" ? nodeSummary.skipped : "unknown";
  const warning = typeof nodeSummary.skipped === "number" && nodeSummary.skipped > 0
    ? "\n\nWarning: skipped tests are not coverage. Treat skipped key tests as review risk."
    : "";

  return `Tests: ${nodeSummary.tests ?? "unknown"}
Passed: ${nodeSummary.pass ?? "unknown"}
Failed: ${nodeSummary.fail ?? "unknown"}
Skipped: ${skipped}
Todo: ${nodeSummary.todo ?? "unknown"}${warning}`;
}

function resolveRepoRoot(startDir) {
  const resolved = path.resolve(startDir);
  const rootResult = runGit(["rev-parse", "--show-toplevel"], resolved);
  if (rootResult.status !== 0) {
    throw new Error(`Not a git repository: ${resolved}`);
  }
  return rootResult.stdout.trim();
}

function hasHead(repoRoot) {
  return runGit(["rev-parse", "--verify", "HEAD"], repoRoot).status === 0;
}

function detectDefaultTestCommand(repoRoot) {
  const packageJson = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJson)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    return pkg.scripts && pkg.scripts.test ? "npm test" : null;
  } catch {
    return null;
  }
}

function section(title, content) {
  return `## ${title}

${content}
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(options.repo);
  const base = hasHead(repoRoot) ? options.base : null;
  const diffArgs = base ? ["diff", base] : ["diff"];
  const diffCommand = base ? `git diff ${base}` : "git diff";
  const generatedAt = new Date().toISOString();

  const branch = runGit(["branch", "--show-current"], repoRoot);
  const status = runGit(["status", "--short", "--branch"], repoRoot);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"], repoRoot);
  const nameStatus = runGit([...diffArgs, "--name-status"], repoRoot);
  const diffStat = runGit([...diffArgs, "--stat"], repoRoot);
  const diffCheck = runGit([...diffArgs, "--check"], repoRoot);
  const fullDiff = runGit(diffArgs, repoRoot);

  const testCmd = options.noTests ? null : options.testCmd || detectDefaultTestCommand(repoRoot);
  const testResult = testCmd ? run(testCmd, [], repoRoot, true) : null;

  const parts = [];
  parts.push(`# CodeFlow Guard Review Context

Generated: ${generatedAt}
Repository: ${repoRoot}
Branch: ${branch.stdout.trim() || "(detached or unknown)"}
Diff base: ${base || "(no HEAD; working tree diff only)"}
`);

  parts.push(section("Repository State", commandBlock("git status --short --branch", status)));
  parts.push(section("Changed Files", commandBlock(`${diffCommand} --name-status`, nameStatus)));
  parts.push(section("Untracked Files", commandBlock("git ls-files --others --exclude-standard", untracked)));
  parts.push(section("Diff Stat", commandBlock(`${diffCommand} --stat`, diffStat)));
  parts.push(section("Diff Check", commandBlock(`${diffCommand} --check`, diffCheck)));

  const diffOutput = truncate(fullDiff.stdout || fullDiff.stderr || "(no diff)", options.maxDiffChars);
  parts.push(section("Full Diff", `Command: ${diffCommand}
Exit code: ${fullDiff.status}

\`\`\`diff
${diffOutput}
\`\`\``));

  parts.push(section("Current File Snapshots", buildFileSnapshots(repoRoot, nameStatus.stdout, options)));

  if (testResult) {
    parts.push(section("Test Result", commandBlock(testCmd, testResult)));
    parts.push(section("Parsed Test Summary", buildParsedTestSummary(testResult)));
  } else {
    parts.push(section("Test Result", "No test command was provided or detected. Use `--test-cmd \"<command>\"` to include test evidence."));
    parts.push(section("Parsed Test Summary", buildParsedTestSummary(null)));
  }

  process.stdout.write(parts.join("\n"));
}

try {
  main();
} catch (error) {
  process.stderr.write(`collect-review-context failed: ${error.message}\n`);
  process.exit(1);
}
