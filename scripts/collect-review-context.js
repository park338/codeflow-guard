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
    maxDiffChars: 120000
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

  if (testResult) {
    parts.push(section("Test Result", commandBlock(testCmd, testResult)));
  } else {
    parts.push(section("Test Result", "No test command was provided or detected. Use `--test-cmd \"<command>\"` to include test evidence."));
  }

  process.stdout.write(parts.join("\n"));
}

try {
  main();
} catch (error) {
  process.stderr.write(`collect-review-context failed: ${error.message}\n`);
  process.exit(1);
}
