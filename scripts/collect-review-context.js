#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Parse command-line arguments into one normalized options object.
 * This keeps CLI handling centralized so the rest of the script can rely on
 * typed option fields instead of repeatedly inspecting raw argv values.
 *
 * @param {string[]} argv Arguments after `node script.js`.
 * @returns {object} Script options, including repo path, diff base, test command,
 * truncation limits, and feature switches.
 */
function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    base: "HEAD",
    testCmd: null,
    noTests: false,
    maxDiffChars: 120000,
    maxFileChars: 20000,
    maxFiles: 20,
    maxAnchors: 200
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
    } else if (arg === "--max-anchors") {
      options.maxAnchors = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

/**
 * Print CLI usage information for humans running the script manually.
 * The output documents only stable public flags; internal implementation
 * details stay out of the help text to keep it short and usable.
 *
 * @returns {void}
 */
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
  --max-anchors <n>         Max changed line anchors to emit. Defaults to 200.
`);
}

/**
 * Execute an external command and normalize its result.
 * The script uses this wrapper instead of calling `spawnSync` directly so all
 * command outputs have the same shape and are safe to render in report blocks.
 *
 * @param {string} command Executable or shell command to run.
 * @param {string[]} args Arguments used when `useShell` is false.
 * @param {string} cwd Working directory for the command.
 * @param {boolean} [useShell=false] Whether to execute via the platform shell.
 * @returns {{status:number, stdout:string, stderr:string, error:string}}
 */
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

/**
 * Execute a git command with repository-stable settings.
 * Disabling `core.autocrlf` for these reads reduces line-ending noise in diff
 * output, which makes later parsing and line anchors more deterministic.
 *
 * @param {string[]} args Git arguments without the leading `git`.
 * @param {string} cwd Repository directory.
 * @returns {{status:number, stdout:string, stderr:string, error:string}}
 */
function runGit(args, cwd) {
  return run("git", ["-c", "core.autocrlf=false", ...args], cwd);
}

/**
 * Convert a command result into a Markdown evidence block.
 * Empty output is made explicit as `(no output)` so the reviewer can distinguish
 * "command produced nothing" from "the evidence section was omitted".
 *
 * @param {string} command Human-readable command label.
 * @param {{status:number, stdout:string, stderr:string, error:string}} result
 * @returns {string} Markdown-formatted command block.
 */
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

/**
 * Build the Changed Files section after removing noisy gitlink paths.
 * Git submodules or nested repositories can appear as changed entries but are
 * not useful for file snapshots or line-level review; they are shown separately
 * so the report stays transparent without polluting the main changed-file list.
 *
 * @param {string} diffCommand Base diff command displayed in the report.
 * @param {{status:number, stdout:string, stderr:string, error:string}} nameStatusResult Raw git name-status result.
 * @param {{status:string, filePath:string}[]} changes Reviewable file changes.
 * @param {{status:string, filePath:string}[]} ignoredGitlinks Filtered gitlink/submodule entries.
 * @returns {string} Markdown command block for changed files.
 */
function buildChangedFilesSection(diffCommand, nameStatusResult, changes, ignoredGitlinks) {
  const lines = changes.length > 0
    ? changes.map(change => `${change.status}\t${change.filePath}`)
    : ["(no output)"];

  if (ignoredGitlinks.length > 0) {
    lines.push("");
    lines.push("Filtered gitlink/submodule paths:");
    for (const change of ignoredGitlinks) {
      lines.push(`${change.status}\t${change.filePath}`);
    }
  }

  return commandBlock(`${diffCommand} --name-status`, {
    status: nameStatusResult.status,
    stdout: lines.join("\n"),
    stderr: nameStatusResult.stderr,
    error: nameStatusResult.error
  });
}

/**
 * Truncate long text while preserving an explicit omission marker.
 * This prevents large diffs or files from overwhelming the model context while
 * still making it clear that the evidence was shortened.
 *
 * @param {string} text Text to truncate.
 * @param {number} maxChars Maximum number of characters to keep.
 * @returns {string} Original text or truncated text with an omission notice.
 */
function truncate(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}

[diff truncated: ${omitted} characters omitted; rerun with --max-diff-chars for a larger context]`;
}

/**
 * Redact sensitive values across a multi-line text block.
 * It applies the same line-level redaction used by findings to full diffs and
 * file snapshots, preventing later report generation from copying raw secrets.
 *
 * @param {string} text Raw multi-line text.
 * @returns {string} Text with sensitive literals masked line by line.
 */
function redactText(text) {
  return text
    .split(/\r?\n/)
    .map(line => redactSensitiveContent(line))
    .join("\n");
}

/**
 * Parse `git diff --name-status` output into structured change records.
 * Git usually separates status and path with tabs, but the fallback whitespace
 * parser keeps the script resilient to copied or platform-normalized output.
 *
 * @param {string} nameStatusOutput Raw name-status output.
 * @returns {{status:string, filePath:string}[]} Parsed change records.
 */
function parseNameStatusLines(nameStatusOutput) {
  return nameStatusOutput
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const tabParts = line.split("\t");
      if (tabParts.length >= 2) {
        return {
          status: tabParts[0].trim(),
          filePath: tabParts[tabParts.length - 1].trim()
        };
      }

      const parts = line.trim().split(/\s+/);
      return {
        status: parts[0] || "",
        filePath: parts[parts.length - 1] || ""
      };
    });
}

/**
 * Determine whether a changed path is a gitlink or nested repository path.
 * In a parent repository, gitlinks behave like directory entries instead of
 * normal text files, so they should not be sent through line-based review logic.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} filePath Repository-relative path.
 * @returns {boolean} True when the path points to a directory-style gitlink.
 */
function isGitlinkPath(repoRoot, filePath) {
  if (!repoRoot || !filePath) {
    return false;
  }

  const absolute = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  try {
    return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Split parsed changes into reviewable files and ignored gitlink entries.
 * Deleted files are also excluded from current snapshots because there is no
 * working-tree file to read; deletion evidence remains available in the diff.
 *
 * @param {{status:string, filePath:string}[]} changes Parsed name-status records.
 * @param {string} repoRoot Repository root for gitlink detection.
 * @returns {{changes:{status:string,filePath:string}[], ignoredGitlinks:{status:string,filePath:string}[]}}
 */
function splitChangedFiles(changes, repoRoot) {
  const kept = [];
  const ignoredGitlinks = [];

  for (const change of changes) {
    if (!change.filePath || change.status.startsWith("D")) {
      continue;
    }

    if (isGitlinkPath(repoRoot, change.filePath)) {
      ignoredGitlinks.push(change);
      continue;
    }

    kept.push(change);
  }

  return { changes: kept, ignoredGitlinks };
}

/**
 * Build the final-report contract injected into the collected context.
 * This gives the reviewing model a compact checklist of hard output rules close
 * to the evidence, reducing drift from the separate SKILL and template files.
 *
 * @param {string|null} testCmd Test command included in the context, if any.
 * @returns {string} Human-readable report contract.
 */
function buildReportContract(testCmd) {
  return `Final review output must include these top-level sections in order:

1. 结论
2. 审查上下文
3. Top 3 必须修复项
4. 变更摘要
5. 关键风险
6. 测试建议
7. 合并前检查清单
8. 复审标准

Hard requirements:
- Do not merge conclusion fields into one line.
- Include risk counts: P0/P1/P2/P3.
- Include the test command: ${testCmd || "(not provided)"}.
- Include Diff Check result.
- Top 3 and every key risk title must include path:line. Use Changed Line Anchors first, then Current File Snapshots.
- Every item in Sensitive Literal Findings must appear in key risks and risk counts. Treat hardcoded key/token/secret/password/connection string as P0 unless clearly harmless test fixture.
- Top 3 must prioritize auth bypass, hardcoded secrets/tokens, data or money risk, and skipped critical tests.
- Do not call pass/skipped ratio coverage unless a coverage tool produced coverage data.
- If skipped tests are present, list them as test risks.`;
}

/**
 * Parse unified diff hunks into `path:line` anchors for changed lines.
 * Added lines use current-file line numbers; deleted lines use old line numbers
 * and are marked as deleted so the report does not invent current locations.
 * Added-line content is redacted before output.
 *
 * @param {string} diffText Raw unified diff.
 * @param {number} maxAnchors Maximum anchors to emit.
 * @param {Set<string>} [ignoredPaths=new Set()] Paths excluded from line anchors.
 * @returns {string} Newline-separated changed-line anchors.
 */
function buildChangedLineAnchors(diffText, maxAnchors, ignoredPaths = new Set()) {
  const anchors = [];
  const lines = diffText.split(/\r?\n/);
  let filePath = null;
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      filePath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      filePath = null;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!filePath || ignoredPaths.has(filePath) || oldLine <= 0 || newLine <= 0) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (anchors.length < maxAnchors) {
        anchors.push(`${filePath}:${newLine} | + ${redactSensitiveContent(line.slice(1))}`);
      } else {
        omitted += 1;
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      if (anchors.length < maxAnchors) {
        anchors.push(`${filePath}:${oldLine} (deleted) | - ${line.slice(1)}`);
      } else {
        omitted += 1;
      }
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (anchors.length === 0) {
    return "No changed line anchors were parsed from diff.";
  }

  if (omitted > 0) {
    anchors.push(`(${omitted} changed line anchors omitted by --max-anchors)`);
  }

  return anchors.join("\n");
}

/**
 * Mask a sensitive value while keeping enough shape for review evidence.
 * Short values are left unchanged because aggressive masking can erase all
 * signal; longer values keep a small prefix and suffix for traceability.
 *
 * @param {string} value Sensitive literal value.
 * @returns {string} Masked value.
 */
function maskSensitiveValue(value) {
  if (!value || value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * Redact common secret, token, password, API key, and connection-string forms.
 * The function is intentionally regex-based because it is applied to diff text,
 * snapshots, and snippets where a full language parser is not always available.
 *
 * @param {string} content One line or snippet of source text.
 * @returns {string} Content with sensitive portions masked.
 */
function redactSensitiveContent(content) {
  let redacted = content.replace(
    /\b((?:mongodb|postgres|mysql|redis):\/\/[^:\s"']+:)([^@\s"']+)(@[^\s"']+)/gi,
    (_, prefix, _password, suffix) => `${prefix}***${suffix}`
  );

  redacted = redacted.replace(/\bsk_live_[A-Za-z0-9_=-]+/g, value => maskSensitiveValue(value));

  return redacted.replace(
    /(\b[A-Za-z_$][\w$]*(?:key|Key|KEY|token|Token|TOKEN|secret|Secret|SECRET|password|Password|PASSWORD|connectionString|ConnectionString|CONNECTION_STRING)\s*[:=]\s*(?:[^,\n]*?(?:\|\||\?\?)\s*)?)(["'])([^"']+)(["'])/g,
    (_, prefix, openQuote, value, closeQuote) => `${prefix}${openQuote}${maskSensitiveValue(value)}${closeQuote}`
  );
}

/**
 * Classify whether an added line contains a sensitive literal.
 * It detects both direct assignments (`token: "..."`) and fallback assignments
 * (`env.TOKEN || "..."`), then returns a label suitable for risk reporting.
 *
 * @param {string} content Added diff line without the leading `+`.
 * @returns {{label:string}|null} Classification result, or null when harmless.
 */
function classifySensitiveLine(content) {
  const sensitiveAssignment = /(?:^|[\s,{])([A-Za-z_$][\w$]*(?:key|Key|KEY|token|Token|TOKEN|secret|Secret|SECRET|password|Password|PASSWORD|connectionString|ConnectionString|CONNECTION_STRING))\s*[:=]\s*(.+)$/.exec(content);
  if (sensitiveAssignment) {
    const rhs = sensitiveAssignment[2];
    if (/(?:\|\||\?\?)\s*["'][^"']+["']/.test(rhs) || /["'][^"']+["']/.test(rhs)) {
      return { label: `hardcoded ${sensitiveAssignment[1]}` };
    }
  }

  const checks = [
    { label: "payment/live key", pattern: /\bsk_live_[A-Za-z0-9_=-]+/ },
    { label: "api key", pattern: /\b(api[_-]?key|apikey)\b\s*[:=][^,\n]*["'][^"']+["']/i },
    { label: "token", pattern: /\b(token|access[_-]?token|refresh[_-]?token|override[_-]?token)\b\s*[:=][^,\n]*["'][^"']+["']/i },
    { label: "secret", pattern: /\b(secret|client[_-]?secret|jwt[_-]?secret)\b\s*[:=][^,\n]*["'][^"']+["']/i },
    { label: "password", pattern: /\b(password|passwd|pwd)\b\s*[:=][^,\n]*["'][^"']+["']/i },
    { label: "connection string", pattern: /\b(mongodb|postgres|mysql|redis):\/\/[^"'\s]+/i }
  ];

  return checks.find(check => check.pattern.test(content)) || null;
}

/**
 * Extract the masked evidence value for a sensitive finding.
 * Connection strings are handled first so password-bearing URIs get specialized
 * redaction instead of a generic quoted-string mask.
 *
 * @param {string} content Source line containing a sensitive literal.
 * @returns {string} Masked evidence value.
 */
function extractSensitiveValue(content) {
  const uri = content.match(/\b(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/i);
  if (uri) {
    return redactSensitiveContent(uri[0]);
  }
  const direct = content.match(/["']([^"']{6,})["']/);
  if (direct) {
    return maskSensitiveValue(direct[1]);
  }
  return "(value not extracted)";
}

/**
 * Build line-level findings for newly added sensitive literals.
 * Only added diff lines are considered because the goal is to flag secrets
 * introduced by the current change, not pre-existing removed values.
 *
 * @param {string} diffText Raw unified diff.
 * @param {Set<string>} [ignoredPaths=new Set()] Paths excluded from findings.
 * @returns {string} Newline-separated findings or a no-findings message.
 */
function buildSensitiveLiteralFindings(diffText, ignoredPaths = new Set()) {
  const findings = [];
  const lines = diffText.split(/\r?\n/);
  let filePath = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      filePath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      filePath = null;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!filePath || ignoredPaths.has(filePath) || oldLine <= 0 || newLine <= 0) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      const classification = classifySensitiveLine(content);
      if (classification) {
        findings.push(`${filePath}:${newLine} | ${classification.label} | ${extractSensitiveValue(content)} | ${redactSensitiveContent(content.trim())}`);
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (findings.length === 0) {
    return "No added hardcoded key/token/secret/password/connection-string-like literals were detected.";
  }

  return findings.join("\n");
}

/**
 * Check whether a path is a JavaScript file that `node --check` can parse.
 * This intentionally excludes TypeScript and JSX because plain Node syntax
 * checking would produce false failures without a project-specific compiler.
 *
 * @param {string} filePath Repository-relative path.
 * @returns {boolean} True for `.js`, `.cjs`, or `.mjs` files.
 */
function isJavaScriptFile(filePath) {
  return [".js", ".cjs", ".mjs"].includes(path.extname(filePath).toLowerCase());
}

/**
 * Run syntax checks for changed JavaScript files.
 * These results provide explicit evidence before the final report claims a
 * syntax error, parser failure, or application-startup risk.
 *
 * @param {string} repoRoot Repository root where commands should run.
 * @param {{status:string, filePath:string}[]} changes Reviewable file changes.
 * @returns {string} Markdown command blocks for syntax checks.
 */
function buildSyntaxCheck(repoRoot, changes) {
  const jsFiles = changes
    .map(change => change.filePath)
    .filter(filePath => filePath && isJavaScriptFile(filePath));

  if (jsFiles.length === 0) {
    return "No changed JavaScript files to syntax-check.";
  }

  return jsFiles.map(filePath => {
    const result = run("node", ["--check", filePath], repoRoot);
    return commandBlock(`node --check ${filePath}`, result);
  }).join("\n\n");
}

/**
 * Decide whether a file is safe and useful to snapshot as text.
 * The extension allowlist avoids binary or irrelevant files while still
 * covering common source, config, documentation, and data formats.
 *
 * @param {string} filePath Repository-relative path.
 * @returns {boolean} True when the path looks like text.
 */
function looksTextLike(filePath) {
  const allowedExtensions = new Set([
    ".cjs", ".css", ".csv", ".env", ".go", ".html", ".java", ".js", ".json",
    ".jsx", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx",
    ".txt", ".xml", ".yaml", ".yml"
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return allowedExtensions.has(ext) || path.basename(filePath).includes(".");
}

/**
 * Read a changed file and add stable line numbers for review.
 * The path is resolved against the repo root and validated to prevent accidental
 * reads outside the repository. File content is redacted before numbering.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} filePath Repository-relative file path.
 * @param {number} maxChars Snapshot truncation limit.
 * @returns {string} Numbered file content or a skip reason.
 */
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
  const numbered = redactText(text)
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
  return truncate(numbered, maxChars);
}

/**
 * Build current-file snapshots for a bounded set of changed files.
 * Snapshots complement diff anchors by showing surrounding current code with
 * line numbers, but the file count limit prevents excessive context growth.
 *
 * @param {string} repoRoot Repository root.
 * @param {{status:string, filePath:string}[]} changes Reviewable file changes.
 * @param {object} options Runtime options containing snapshot limits.
 * @returns {string} Markdown snapshots.
 */
function buildFileSnapshots(repoRoot, changes, options) {
  const scopedChanges = changes.slice(0, options.maxFiles);
  if (scopedChanges.length === 0) {
    return "No changed text files to snapshot.";
  }

  const snapshots = scopedChanges.map(change => {
    const numbered = readNumberedFile(repoRoot, change.filePath, options.maxFileChars);
    return `### ${change.status} ${change.filePath}

\`\`\`text
${numbered}
\`\`\``;
  });

  const omitted = changes.length - scopedChanges.length;
  if (omitted > 0) {
    snapshots.push(`(${omitted} changed files omitted by --max-files)`);
  }
  return snapshots.join("\n\n");
}

/**
 * Parse Node.js test-runner summary lines.
 * The parser focuses on stable counts (`tests`, `pass`, `fail`, `skipped`,
 * `todo`) so the final report can distinguish skipped tests from coverage.
 *
 * @param {string} output Combined stdout and stderr from a test command.
 * @returns {object|null} Parsed summary counts, or null if unavailable.
 */
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

/**
 * Build a compact parsed test summary for the review context.
 * When skipped tests are present, the warning explicitly prevents treating
 * pass/skipped ratios as coverage evidence.
 *
 * @param {{stdout:string, stderr:string}|null} testResult Raw test command result.
 * @returns {string} Parsed test summary or fallback guidance.
 */
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

/**
 * Resolve an arbitrary starting directory to its git repository root.
 * Failing early here prevents later git and file operations from producing
 * misleading empty evidence outside a repository.
 *
 * @param {string} startDir User-provided repo or subdirectory.
 * @returns {string} Absolute git repository root.
 */
function resolveRepoRoot(startDir) {
  const resolved = path.resolve(startDir);
  const rootResult = runGit(["rev-parse", "--show-toplevel"], resolved);
  if (rootResult.status !== 0) {
    throw new Error(`Not a git repository: ${resolved}`);
  }
  return rootResult.stdout.trim();
}

/**
 * Check whether the repository has a valid HEAD commit.
 * Newly initialized repositories may not have HEAD yet, so diff command
 * selection must handle that case explicitly.
 *
 * @param {string} repoRoot Repository root.
 * @returns {boolean} True when HEAD exists.
 */
function hasHead(repoRoot) {
  return runGit(["rev-parse", "--verify", "HEAD"], repoRoot).status === 0;
}

/**
 * Detect a default npm test command from package.json.
 * This provides a useful zero-configuration path while still allowing users to
 * override tests with `--test-cmd` or disable them with `--no-tests`.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string|null} `npm test` when available, otherwise null.
 */
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

/**
 * Render a named Markdown section with consistent spacing.
 * Keeping section formatting centralized prevents subtle Markdown layout
 * regressions as evidence sections are added or reordered.
 *
 * @param {string} title Section title.
 * @param {string} content Section body.
 * @returns {string} Markdown section.
 */
function section(title, content) {
  return `## ${title}

${content}
`;
}

/**
 * Collect all review evidence and print a single Markdown context document.
 * The function orchestrates git state, diff evidence, syntax checks, sensitive
 * literal findings, file snapshots, tests, and parsed summaries in a fixed
 * order so downstream review output is stable and auditable.
 *
 * @returns {void}
 */
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
  const parsedChangedFiles = parseNameStatusLines(nameStatus.stdout);
  const { changes: changedFiles, ignoredGitlinks } = splitChangedFiles(parsedChangedFiles, repoRoot);
  const ignoredPaths = new Set(ignoredGitlinks.map(change => change.filePath));

  const testCmd = options.noTests ? null : options.testCmd || detectDefaultTestCommand(repoRoot);
  const testResult = testCmd ? run(testCmd, [], repoRoot, true) : null;

  const parts = [];
  parts.push(`# CodeFlow Guard Review Context

Generated: ${generatedAt}
Repository: ${repoRoot}
Branch: ${branch.stdout.trim() || "(detached or unknown)"}
Diff base: ${base || "(no HEAD; working tree diff only)"}
`);

  parts.push(section("Report Contract", buildReportContract(testCmd)));
  parts.push(section("Repository State", commandBlock("git status --short --branch", status)));
  parts.push(section("Changed Files", buildChangedFilesSection(diffCommand, nameStatus, changedFiles, ignoredGitlinks)));
  parts.push(section("Untracked Files", commandBlock("git ls-files --others --exclude-standard", untracked)));
  parts.push(section("Diff Stat", commandBlock(`${diffCommand} --stat`, diffStat)));
  parts.push(section("Diff Check", commandBlock(`${diffCommand} --check`, diffCheck)));
  parts.push(section("Syntax Check", buildSyntaxCheck(repoRoot, changedFiles)));
  parts.push(section("Sensitive Literal Findings", buildSensitiveLiteralFindings(fullDiff.stdout || "", ignoredPaths)));
  parts.push(section("Changed Line Anchors", buildChangedLineAnchors(fullDiff.stdout || "", options.maxAnchors, ignoredPaths)));

  const diffOutput = truncate(redactText(fullDiff.stdout || fullDiff.stderr || "(no diff)"), options.maxDiffChars);
  parts.push(section("Full Diff", `Command: ${diffCommand}
Exit code: ${fullDiff.status}

\`\`\`diff
${diffOutput}
\`\`\``));

  parts.push(section("Current File Snapshots", buildFileSnapshots(repoRoot, changedFiles, options)));

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
