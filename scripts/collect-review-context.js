#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Read the value that must follow a command-line option.
 * 中文：读取命令行选项后必须跟随的值，缺失时立即报错。
 * Failing early prevents a later option name from being accidentally consumed as
 * a repository path, diff base, test command, or numeric limit.
 *
 * @param {string[]} argv Arguments after `node script.js`.
 * @param {number} index Current option index.
 * @param {string} optionName Option being parsed.
 * @returns {string} The following argument value.
 */
function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value. Run with --help for usage.`);
  }
  return value;
}

/**
 * Parse a numeric command-line option with validation.
 * 中文：解析并校验数值型命令行选项，避免 NaN 或非正数进入后续逻辑。
 *
 * @param {string[]} argv Arguments after `node script.js`.
 * @param {number} index Current option index.
 * @param {string} optionName Option being parsed.
 * @returns {number} Positive finite numeric option value.
 */
function readPositiveNumberOption(argv, index, optionName) {
  const rawValue = readOptionValue(argv, index, optionName);
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive number. Received: ${rawValue}`);
  }
  return value;
}

/**
 * Parse command-line arguments into one normalized options object.
 * 中文：解析命令行参数，统一生成脚本后续使用的配置对象。
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
    maxAnchors: 200,
    briefOnly: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      options.repo = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--base") {
      options.base = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--test-cmd") {
      options.testCmd = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--no-tests") {
      options.noTests = true;
    } else if (arg === "--brief-only") {
      options.briefOnly = true;
    } else if (arg === "--max-diff-chars") {
      options.maxDiffChars = readPositiveNumberOption(argv, i, arg);
      i += 1;
    } else if (arg === "--max-file-chars") {
      options.maxFileChars = readPositiveNumberOption(argv, i, arg);
      i += 1;
    } else if (arg === "--max-files") {
      options.maxFiles = readPositiveNumberOption(argv, i, arg);
      i += 1;
    } else if (arg === "--max-anchors") {
      options.maxAnchors = readPositiveNumberOption(argv, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
    }
  }

  return options;
}

/**
 * Print CLI usage information for humans running the script manually.
 * 中文：输出脚本帮助信息，方便手动运行时查看可用参数。
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
  --brief-only              Print only the compact review brief.
`);
}

/**
 * Normalize repository-relative paths for Git pathspecs and set comparisons.
 * 中文：把仓库相对路径规范化为 Git pathspec 友好的正斜杠格式。
 * Git accepts forward slashes on every platform; normalizing once prevents
 * Windows backslashes from breaking include/exclude scope rules.
 *
 * @param {string} filePath Repository-relative path or pathspec.
 * @returns {string} Normalized repository path.
 */
function normalizeRepoPath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Normalize and deduplicate a list of repository pathspecs.
 * 中文：规范化并去重仓库 pathspec 列表，避免重复范围让输出变得嘈杂。
 *
 * @param {string[]} paths Raw pathspec list.
 * @returns {string[]} Stable unique pathspec list.
 */
function normalizePathList(paths) {
  const seen = new Set();
  const normalized = [];

  for (const entry of paths || []) {
    const value = normalizeRepoPath(entry);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

/**
 * Build scoped Git pathspec arguments from excluded paths.
 * 中文：根据排除路径构造 Git pathspec 参数。
 * The script always reviews the full target repository. Pathspecs are added
 * only when support paths, such as the Skill's own directory, must be excluded.
 *
 * @param {string[]} ignoredPaths Repository-relative paths to exclude.
 * @returns {string[]} Git arguments beginning with `--`, or an empty list.
 */
function buildPathspecArgs(ignoredPaths = []) {
  const ignores = normalizePathList(ignoredPaths);
  if (ignores.length === 0) {
    return [];
  }

  return [
    "--",
    ".",
    ...ignores.map(ignoredPath => `:(exclude)${ignoredPath}`)
  ];
}

/**
 * Quote a command argument for display in the generated evidence document.
 * 中文：为报告中的可读命令参数加引号，避免空格或 pathspec 魔法字符造成歧义。
 * Actual execution still uses structured argument arrays; this is display-only.
 *
 * @param {string} value Command argument.
 * @returns {string} Quoted argument for human-readable command text.
 */
function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Render display-only exclude pathspec command parts matching `buildPathspecArgs`.
 * 中文：生成和实际 pathspec 参数一致的可读命令片段。
 *
 * @param {string[]} ignoredPaths Repository-relative excluded paths.
 * @returns {string[]} Display command parts.
 */
function buildPathspecCommandParts(ignoredPaths = []) {
  const ignores = normalizePathList(ignoredPaths);
  if (ignores.length === 0) {
    return [];
  }

  return [
    "--",
    quoteCommandArg("."),
    ...ignores.map(ignoredPath => quoteCommandArg(`:(exclude)${ignoredPath}`))
  ];
}

/**
 * Append review scope pathspecs to an arbitrary Git command.
 * 中文：给任意 Git 命令追加审查范围 pathspec，确保状态、diff、未跟踪文件使用同一范围。
 *
 * @param {string[]} args Git arguments before pathspecs.
 * @param {string[]} ignoredPaths Repository-relative paths to exclude.
 * @returns {string[]} Scoped Git arguments.
 */
function buildScopedGitArgs(args, ignoredPaths = []) {
  return [...args, ...buildPathspecArgs(ignoredPaths)];
}

/**
 * Render a display command for a scoped Git command.
 * 中文：生成带审查范围的可读 Git 命令，方便报告追溯证据来源。
 *
 * @param {string[]} args Git arguments before pathspecs.
 * @param {string[]} ignoredPaths Repository-relative paths to exclude.
 * @returns {string} Display command.
 */
function buildScopedGitCommand(args, ignoredPaths = []) {
  return ["git", ...args, ...buildPathspecCommandParts(ignoredPaths)].join(" ");
}

/**
 * Execute an external command and normalize its result.
 * 中文：执行外部命令，并把返回码、标准输出和错误输出整理成统一结构。
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
 * 中文：执行 git 命令，并固定读取配置，减少换行符带来的 diff 噪声。
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
 * 中文：把命令执行结果转换成 Markdown 证据块，供后续审查报告引用。
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
 * Combine command results when one report section has multiple evidence sources.
 * 中文：当一个报告区块来自多个证据来源时，合并命令结果并保留所有输出。
 * This keeps section output complete without pretending synthetic evidence came
 * from a single raw Git command.
 *
 * @param {...{status:number, stdout:string, stderr:string, error:string}[]} results Command results.
 * @returns {{status:number, stdout:string, stderr:string, error:string}} Combined command result.
 */
function combineCommandResults(...results) {
  return {
    status: results.some(result => result.status !== 0) ? results.find(result => result.status !== 0).status : 0,
    stdout: results.map(result => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map(result => result.stderr).filter(Boolean).join("\n"),
    error: results.map(result => result.error).filter(Boolean).join("\n")
  };
}

/**
 * Build the Changed Files section after removing noisy gitlink paths.
 * 中文：生成变更文件区块，并把 gitlink 或子仓库路径单独过滤展示。
 * Git submodules or nested repositories can appear as changed entries but are
 * not useful for file snapshots or line-level review; they are shown separately
 * so the report stays transparent without polluting the main changed-file list.
 *
 * @param {string} diffCommand Full diff command displayed in the report.
 * @param {{status:number, stdout:string, stderr:string, error:string}} nameStatusResult Raw git name-status result.
 * @param {{status:string, filePath:string}[]} changes Reviewable file changes.
 * @param {{status:string, filePath:string}[]} ignoredChanges Filtered support entries.
 * @returns {string} Markdown command block for changed files.
 */
function buildChangedFilesSection(diffCommand, nameStatusResult, changes, ignoredChanges) {
  const lines = changes.length > 0
    ? changes.map(change => `${change.status}\t${change.filePath}`)
    : ["(no output)"];

  if (ignoredChanges.length > 0) {
    lines.push("");
    lines.push("Filtered support paths:");
    for (const change of ignoredChanges) {
      lines.push(`${change.status}\t${change.filePath}`);
    }
  }

  return commandBlock(diffCommand, {
    status: nameStatusResult.status,
    stdout: lines.join("\n"),
    stderr: nameStatusResult.stderr,
    error: nameStatusResult.error
  });
}

/**
 * Build git diff arguments with optional path exclusions.
 * 中文：构造 git diff 参数，并在统一审查范围内排除 Skill 自身等辅助路径。
 * Pathspecs are applied after `--` so every diff-derived evidence section reads
 * the same review scope.
 *
 * @param {string|null} base Diff base ref, or null for working-tree diff only.
 * @param {string[]} options Git diff options such as `--stat` or `--check`.
 * @param {string[]} ignoredPaths Repository-relative paths to exclude.
 * @returns {string[]} Arguments passed to `git`.
 */
function buildDiffArgs(base, options = [], ignoredPaths = []) {
  const args = ["diff"];
  if (base) {
    args.push(base);
  }
  args.push(...options);
  return buildScopedGitArgs(args, ignoredPaths);
}

/**
 * Render the human-readable command matching `buildDiffArgs`.
 * 中文：生成和实际 git diff 参数一致的可读命令，便于报告追溯证据来源。
 * The command string is for evidence display only; command execution uses the
 * structured argument array to avoid shell quoting issues.
 *
 * @param {string|null} base Diff base ref, or null for working-tree diff only.
 * @param {string[]} options Git diff options.
 * @param {string[]} ignoredPaths Repository-relative excluded paths.
 * @returns {string} Display command.
 */
function buildDiffCommand(base, options = [], ignoredPaths = []) {
  const parts = ["git", "diff"];
  if (base) {
    parts.push(base);
  }
  parts.push(...options);
  return [...parts, ...buildPathspecCommandParts(ignoredPaths)].join(" ");
}

/**
 * Truncate long text while preserving an explicit omission marker.
 * 中文：截断过长文本，并保留明确的省略提示，避免上下文过大。
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
 * 中文：对多行文本逐行脱敏，避免完整密钥或连接串进入报告上下文。
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
 * 中文：解析 `git diff --name-status` 输出，得到结构化的变更文件记录。
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
 * Parse `git ls-files --others` output into added-file change records.
 * 中文：把未跟踪文件列表转换为新增文件变更记录，确保新文件也进入完整审查链路。
 * These records are merged with diff-derived changes so syntax checks,
 * snapshots, priority findings, and sensitive literal checks do not miss newly
 * created files that have not been staged yet.
 *
 * @param {string} untrackedOutput Raw untracked-file list from Git.
 * @returns {{status:string, filePath:string}[]} Added-file records.
 */
function parseUntrackedLines(untrackedOutput) {
  return untrackedOutput
    .split(/\r?\n/)
    .map(line => normalizeRepoPath(line.trim()))
    .filter(Boolean)
    .map(filePath => ({ status: "A", filePath }));
}

/**
 * Merge changed-file records while preserving the first status seen per path.
 * 中文：合并变更文件记录，并按路径去重，避免同一文件重复进入快照和语法检查。
 * Diff records take precedence over untracked records because they contain the
 * authoritative Git status for tracked paths.
 *
 * @param {...{status:string,filePath:string}[][]} changeGroups Change arrays.
 * @returns {{status:string,filePath:string}[]} Deduplicated changes.
 */
function mergeChangeRecords(...changeGroups) {
  const merged = [];
  const seen = new Set();

  for (const group of changeGroups) {
    for (const change of group || []) {
      const filePath = normalizeRepoPath(change.filePath);
      if (!filePath || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      merged.push({ status: change.status, filePath });
    }
  }

  return merged;
}

/**
 * Determine whether a changed path is a gitlink or nested repository path.
 * 中文：判断变更路径是否为 gitlink 或嵌套仓库，避免当作普通文本文件处理。
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
 * Determine whether a changed path belongs to this skill package while another
 * repository is being reviewed.
 * 中文：判断变更路径是否属于当前 Skill 自身；审查外层业务仓库时应过滤这些路径。
 * This prevents skill implementation edits from polluting product-code review,
 * but it still allows this repository to review and maintain the skill itself.
 *
 * @param {string} repoRoot Repository root being inspected.
 * @param {string} filePath Repository-relative changed path.
 * @returns {boolean} True when the path points inside this skill package.
 */
function isOwnSkillPath(repoRoot, filePath) {
  if (!repoRoot || !filePath) {
    return false;
  }

  const skillRoot = path.resolve(__dirname, "..");
  const reviewedRoot = path.resolve(repoRoot);
  if (reviewedRoot === skillRoot) {
    return false;
  }

  const absolute = path.resolve(reviewedRoot, filePath);
  const relativeToSkill = path.relative(skillRoot, absolute);
  return relativeToSkill === "" || (!relativeToSkill.startsWith("..") && !path.isAbsolute(relativeToSkill));
}

/**
 * Resolve this Skill package as an excluded path when reviewing an outer repo.
 * 中文：审查外层业务仓库时，计算当前 Skill 自身应被排除的仓库相对路径。
 * This static exclusion also hides untracked Skill files from status sections,
 * not only files that already appear in `git diff --name-status`.
 *
 * @param {string} repoRoot Repository root being inspected.
 * @returns {string|null} Repository-relative Skill path to exclude, if any.
 */
function getOwnSkillIgnoredPath(repoRoot) {
  const skillRoot = path.resolve(__dirname, "..");
  const reviewedRoot = path.resolve(repoRoot);
  if (reviewedRoot === skillRoot) {
    return null;
  }

  const relative = path.relative(reviewedRoot, skillRoot);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return normalizeRepoPath(relative);
}

/**
 * Split parsed changes into reviewable files and ignored gitlink entries.
 * 中文：把变更拆分为可审查文件和需要忽略的 gitlink 条目。
 * Deleted files remain reviewable for diff evidence, but later snapshot and
 * syntax-check steps skip them because no current working-tree file exists.
 *
 * @param {{status:string, filePath:string}[]} changes Parsed name-status records.
 * @param {string} repoRoot Repository root for gitlink detection.
 * @returns {{changes:{status:string,filePath:string}[], ignoredChanges:{status:string,filePath:string}[]}}
 */
function splitChangedFiles(changes, repoRoot) {
  const kept = [];
  const ignoredChanges = [];

  for (const change of changes) {
    if (!change.filePath) {
      continue;
    }

    if (isOwnSkillPath(repoRoot, change.filePath) || isGitlinkPath(repoRoot, change.filePath)) {
      ignoredChanges.push(change);
      continue;
    }

    kept.push(change);
  }

  return { changes: kept, ignoredChanges };
}

/**
 * Filter untracked files with the same support-path rules used for tracked diffs.
 * 中文：使用和跟踪文件 diff 相同的辅助路径规则过滤未跟踪文件。
 * This keeps the "all repository changes except Skill support paths" promise
 * consistent across tracked, unstaged, staged, and untracked changes.
 *
 * @param {string} untrackedOutput Raw untracked-file list from Git.
 * @param {string} repoRoot Repository root for path filtering.
 * @returns {{changes:{status:string,filePath:string}[], ignoredChanges:{status:string,filePath:string}[]}}
 */
function splitUntrackedFiles(untrackedOutput, repoRoot) {
  return splitChangedFiles(parseUntrackedLines(untrackedOutput), repoRoot);
}

/**
 * Render excluded paths for the document header.
 * 中文：把审查排除范围渲染到报告头部，避免使用者误解当前脚本忽略了哪些路径。
 *
 * @param {string[]} ignoredPaths Repository-relative excluded paths.
 * @returns {string} One-line scope summary.
 */
function buildReviewScopeSummary(ignoredPaths) {
  const ignores = normalizePathList(ignoredPaths);
  return `Review scope: all repository changes${ignores.length > 0 ? ` except ${ignores.join(", ")}` : ""}`;
}

/**
 * Escape a line for safe inclusion in a synthetic unified diff.
 * 中文：对合成 unified diff 中的单行内容做基础清理，避免二进制或控制字符破坏输出结构。
 *
 * @param {string} line Source line.
 * @returns {string} Diff-safe line.
 */
function sanitizeDiffLine(line) {
  return line.replace(/\0/g, "\\0");
}

/**
 * Read an untracked text file and render it as a standard added-file diff.
 * 中文：读取未跟踪文本文件，并渲染为标准新增文件 diff。
 * The generated shape mirrors Git's unified diff enough for the script's own
 * parsers and for downstream LLM review, without requiring staging.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} filePath Repository-relative file path.
 * @returns {string|null} Synthetic diff text, or null when skipped.
 */
function buildAddedFileDiff(repoRoot, filePath) {
  const normalizedPath = normalizeRepoPath(filePath);
  const lines = readRepoTextLines(repoRoot, normalizedPath);
  if (!lines) {
    return null;
  }

  const body = lines.map(line => `+${sanitizeDiffLine(line)}`);
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...body
  ].join("\n");
}

/**
 * Read normalized lines from a repository text file.
 * 中文：读取仓库内文本文件并统一换行，供未跟踪文件的合成证据复用。
 *
 * @param {string} repoRoot Repository root.
 * @param {string} filePath Repository-relative file path.
 * @returns {string[]|null} Text lines, or null when the file should be skipped.
 */
function readRepoTextLines(repoRoot, filePath) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativeRoot = path.relative(repoRoot, absolutePath);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    return null;
  }
  if (!fs.existsSync(absolutePath) || !looksTextLike(filePath)) {
    return null;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) {
    return null;
  }

  const text = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.length > 0 ? text.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Build a small stat summary for untracked text files.
 * 中文：为未跟踪文本文件生成简洁 stat 摘要，补齐 `git diff --stat` 覆盖不到的新文件。
 *
 * @param {string} repoRoot Repository root.
 * @param {{status:string,filePath:string}[]} untrackedChanges Reviewable untracked files.
 * @returns {{status:number, stdout:string, stderr:string, error:string}} Synthetic stat result.
 */
function buildUntrackedStat(repoRoot, untrackedChanges) {
  const lines = [];
  for (const change of untrackedChanges) {
    const textLines = readRepoTextLines(repoRoot, change.filePath);
    if (!textLines) {
      continue;
    }
    const additions = textLines.length;
    const pluses = "+".repeat(Math.min(additions, 80));
    lines.push(`${change.filePath} | ${additions} ${pluses}`);
  }

  return {
    status: 0,
    stdout: lines.join("\n"),
    stderr: "",
    error: ""
  };
}

/**
 * Run a lightweight whitespace check for untracked text files.
 * 中文：对未跟踪文本文件执行轻量空白检查，弥补 `git diff --check` 不检查新文件的问题。
 *
 * @param {string} repoRoot Repository root.
 * @param {{status:string,filePath:string}[]} untrackedChanges Reviewable untracked files.
 * @returns {{status:number, stdout:string, stderr:string, error:string}} Synthetic check result.
 */
function buildUntrackedDiffCheck(repoRoot, untrackedChanges) {
  const findings = [];
  for (const change of untrackedChanges) {
    const textLines = readRepoTextLines(repoRoot, change.filePath);
    if (!textLines) {
      continue;
    }
    textLines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) {
        findings.push(`${change.filePath}:${index + 1}: trailing whitespace.`);
        findings.push(`+${line}`);
      }
    });
  }

  return {
    status: findings.length > 0 ? 2 : 0,
    stdout: findings.join("\n"),
    stderr: "",
    error: ""
  };
}

/**
 * Build a synthetic diff for untracked text files.
 * 中文：为未跟踪文本文件生成合成 diff，让新文件也能进入风险预扫描和行锚点。
 * Git's normal working-tree diff omits untracked files. Synthetic added-file
 * hunks give downstream parsers the same evidence shape without requiring
 * users to stage their work.
 *
 * @param {string} repoRoot Repository root.
 * @param {{status:string,filePath:string}[]} untrackedChanges Reviewable untracked files.
 * @returns {{status:number, stdout:string, stderr:string, error:string}} Synthetic diff result.
 */
function buildUntrackedDiff(repoRoot, untrackedChanges) {
  const diffParts = [];

  for (const change of untrackedChanges) {
    const syntheticDiff = buildAddedFileDiff(repoRoot, change.filePath);
    if (syntheticDiff) {
      diffParts.push(syntheticDiff);
    }
  }

  return {
    status: 0,
    stdout: diffParts.join("\n"),
    stderr: "",
    error: ""
  };
}

/**
 * Combine tracked and untracked diff results into one review diff.
 * 中文：合并跟踪文件 diff 和未跟踪文件合成 diff，形成完整审查输入。
 *
 * @param {{status:number, stdout:string, stderr:string, error:string}} trackedDiff Tracked Git diff.
 * @param {{status:number, stdout:string, stderr:string, error:string}} untrackedDiff Synthetic untracked diff.
 * @returns {{status:number, stdout:string, stderr:string, error:string}} Combined diff result.
 */
function combineDiffResults(trackedDiff, untrackedDiff) {
  return {
    status: trackedDiff.status !== 0 ? trackedDiff.status : untrackedDiff.status,
    stdout: [trackedDiff.stdout, untrackedDiff.stdout].filter(Boolean).join("\n"),
    stderr: [trackedDiff.stderr, untrackedDiff.stderr].filter(Boolean).join("\n"),
    error: [trackedDiff.error, untrackedDiff.error].filter(Boolean).join("\n")
  };
}

/**
 * Build the final-report contract injected into the collected context.
 * 中文：生成最终报告契约，直接放入采集上下文中约束模型输出。
 * This gives the reviewing model a compact checklist of hard output rules close
 * to the evidence, reducing drift from the separate SKILL and template files.
 *
 * @param {string|null} testCmd Test command included in the context, if any.
 * @returns {string} Human-readable report contract.
 */
function buildReportContract(testCmd) {
  return `最终报告按 ` + "`references/output-template.md`" + ` 的 8 个章节输出：

1. 结论
2. 审查上下文
3. Top 3 必须修复项
4. 变更摘要
5. 关键风险
6. 测试建议
7. 合并前检查清单
8. 复审标准

优先级：
1. 先按 Review Brief 做覆盖判断；“待判断文件”里的每个文件都必须进入“变更摘要”并给出判断。
2. “必须覆盖风险”必须进入 Top 3 或关键风险，并计入风险计数。
3. 最终结论不得低于 Review Brief 的结论下限；可以更严格。

硬约束：
- 结论区一项一行，包含合并建议、总体风险、摘要、风险计数、测试状态和测试结果。
- 审查上下文必须包含测试命令：${testCmd || "(not provided)"}，以及 Diff Check 结果。
- Top 3 和关键风险标题使用 path:line；优先取 Changed Line Anchors，再取 Current File Snapshots。
- Sensitive Literal Findings 全部进入关键风险和风险计数；敏感值只引用脱敏证据。
- 没有 coverage 工具输出时，不要把通过/跳过比例写成覆盖率。
- skipped 测试必须作为测试风险。`;
}

/**
 * Parse unified diff hunks into `path:line` anchors for changed lines.
 * 中文：从 unified diff 中提取 `path:line` 行锚点，帮助报告引用准确位置。
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
  let oldFilePath = null;
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;

  for (const line of lines) {
    if (line.startsWith("--- a/")) {
      oldFilePath = line.slice("--- a/".length);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      filePath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      filePath = oldFilePath;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!filePath || ignoredPaths.has(filePath) || newLine <= 0) {
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

    if (line.startsWith("-") && !line.startsWith("---") && oldLine > 0) {
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
 * 中文：遮蔽敏感值，同时保留少量前后缀，便于定位同一条证据。
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
 * 中文：脱敏常见密钥、令牌、密码、API Key 和数据库连接串。
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
 * 中文：判断新增代码行是否包含敏感字面量，并给出风险标签。
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
 * 中文：从敏感代码行中提取已脱敏的证据值。
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
 * Walk a unified diff and expose added/deleted lines with file and line metadata.
 * 中文：遍历 unified diff，把新增/删除行转换为包含文件和行号的结构化记录。
 * Several higher-level detectors share this parser so line-number behavior stays
 * consistent across priority findings, anchors, and sensitive literal checks.
 *
 * @param {string} diffText Raw unified diff.
 * @param {Set<string>} [ignoredPaths=new Set()] Paths excluded from detection.
 * @returns {{filePath:string,lineNumber:number,oldLineNumber:number,kind:string,content:string}[]} Changed line records.
 */
function parseDiffLineRecords(diffText, ignoredPaths = new Set()) {
  const records = [];
  const lines = diffText.split(/\r?\n/);
  let filePath = null;
  let oldFilePath = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("--- a/")) {
      oldFilePath = line.slice("--- a/".length);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      filePath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      filePath = oldFilePath;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!filePath || ignoredPaths.has(filePath) || newLine <= 0) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      records.push({
        filePath,
        lineNumber: newLine,
        oldLineNumber: oldLine,
        kind: "added",
        content: line.slice(1)
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---") && oldLine > 0) {
      records.push({
        filePath,
        lineNumber: oldLine,
        oldLineNumber: oldLine,
        kind: "deleted",
        content: line.slice(1)
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return records;
}

/**
 * Convert a priority finding object into a compact Markdown evidence card.
 * 中文：把结构化优先级风险转换为便于 LLM 读取的紧凑证据卡片。
 * The output is intentionally repetitive and explicit so mandatory report
 * actions are hard to miss during final report generation.
 *
 * @param {{severity:string,type:string,location:string,evidence:string,requiredAction:string}} finding Priority finding.
 * @param {number} index One-based finding index.
 * @returns {string} Markdown finding card.
 */
function formatPriorityFinding(finding, index) {
  return `### F${index} ${finding.severity} ${finding.type}

- Location: ${finding.location}
- Evidence: ${finding.evidence}
- Required report action: ${finding.requiredAction}`;
}

/**
 * Count priority findings by severity.
 * 中文：按严重等级统计优先级风险，供简版摘要和决策下限复用。
 *
 * @param {{severity:string}[]} findings Priority findings.
 * @returns {{P0:number,P1:number,P2:number,P3:number}} Severity counts.
 */
function countFindingsBySeverity(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

/**
 * Derive the minimum overall risk and merge advice from finding counts.
 * 中文：根据风险计数推导最低总体风险和最低合并建议。
 *
 * @param {{P0:number,P1:number,P2:number,P3:number}} counts Severity counts.
 * @returns {{minimumRisk:string,minimumAdvice:string}} Decision floor.
 */
function buildDecisionFloor(counts) {
  const minimumRisk = counts.P0 > 0 ? "P0" : counts.P1 > 0 ? "P1" : counts.P2 > 0 ? "P2" : counts.P3 > 0 ? "P3" : "P3";
  const minimumAdvice = counts.P0 > 0 ? "不建议合并" : counts.P1 > 0 ? "补测后合并" : "可合并";
  return { minimumRisk, minimumAdvice };
}

/**
 * Render a short one-line priority finding for the brief section.
 * 中文：把优先级风险渲染成一行摘要，降低 LLM 首屏输入复杂度。
 *
 * @param {{severity:string,type:string,location:string,evidence:string}} finding Priority finding.
 * @param {number} index One-based finding index.
 * @returns {string} Compact finding line.
 */
function formatPriorityFindingBrief(finding, index) {
  return `${index}. ${finding.severity} ${finding.type} | ${finding.location} | ${finding.evidence}`;
}

/**
 * Render a bounded changed-file list for the brief section.
 * 中文：生成有上限的变更文件清单，帮助模型先覆盖所有文件族。
 *
 * @param {{status:string,filePath:string}[]} changedFiles Reviewable changed files.
 * @param {number} [maxFiles=40] Maximum entries in the brief.
 * @returns {string} Compact changed-file list.
 */
function buildChangedFilesBrief(changedFiles, maxFiles = 80) {
  if (changedFiles.length === 0) {
    return "- 未检测到待审变更文件";
  }

  const lines = changedFiles
    .slice(0, maxFiles)
    .map((change, index) => `${index + 1}. ${change.status} ${change.filePath}`);
  const omitted = changedFiles.length - lines.length;
  if (omitted > 0) {
    lines.push(`... 还有 ${omitted} 个文件未在简报展开；最终报告前必须读取 Changed Files 全量清单。`);
  }
  return lines.join("\n");
}

/**
 * Render a bounded must-cover finding list for the brief section.
 * 中文：生成必须覆盖风险的简表，确保报告不会漏掉关键判断。
 *
 * @param {{severity:string,type:string,location:string,evidence:string}[]} findings Priority findings.
 * @param {number} [maxFindings=15] Maximum entries in the brief.
 * @returns {string} Compact finding list.
 */
function buildPriorityFindingsBrief(findings, maxFindings = 15) {
  if (findings.length === 0) {
    return "- 规则预扫未命中高优先级风险；仍需逐个判断待判断文件。";
  }

  const lines = findings
    .slice(0, maxFindings)
    .map((finding, index) => `- ${formatPriorityFindingBrief(finding, index + 1)}`);
  const omitted = findings.length - lines.length;
  if (omitted > 0) {
    lines.push(`- 还有 ${omitted} 个风险未在简报展开；最终报告前必须读取 Priority Findings 全量清单。`);
  }
  return lines.join("\n");
}

/**
 * Summarize parsed test evidence for the brief section.
 * 中文：为简版摘要生成测试证据，避免把 skipped 或未解析结果误读为覆盖率。
 *
 * @param {string|null} testCmd Test command.
 * @param {{status:number}|null} testResult Test command result.
 * @param {object|null} parsedTestSummary Parsed test summary.
 * @returns {string} Compact test summary.
 */
function buildTestBrief(testCmd, testResult, parsedTestSummary) {
  if (!testCmd || !testResult) {
    return "- 测试命令：(未提供)\n- 测试结果：未运行";
  }

  const parsed = parsedTestSummary
    ? `总数=${parsedTestSummary.tests ?? "unknown"}，通过=${parsedTestSummary.pass ?? "unknown"}，失败=${parsedTestSummary.fail ?? "unknown"}，跳过=${parsedTestSummary.skipped ?? "unknown"}`
    : "未解析到结构化统计，需读取 Test Result 原始输出";

  return `- 测试命令：${testCmd}
- 退出码：${testResult.status}
- 统计：${parsed}`;
}

/**
 * Build the first, compact section the LLM should use before detailed evidence.
 * 中文：生成首屏简版审查摘要，让模型先抓住完整变更范围和最低结论。
 * Directory names are not treated as skip signals; every listed changed file is
 * review evidence and needs a file-level judgment.
 *
 * @param {object} input Review evidence inputs.
 * @param {{status:string,filePath:string}[]} input.changedFiles Reviewable changes.
 * @param {{severity:string,type:string,location:string,evidence:string}[]} input.priorityFindings Priority findings.
 * @param {string|null} input.testCmd Test command.
 * @param {{status:number}|null} input.testResult Test command result.
 * @param {object|null} input.parsedTestSummary Parsed test summary.
 * @param {{status:number}} input.diffCheck Diff check result.
 * @returns {string} Compact Markdown brief.
 */
function buildReviewBrief({ changedFiles, priorityFindings, testCmd, testResult, parsedTestSummary, diffCheck }) {
  const counts = countFindingsBySeverity(priorityFindings);
  const { minimumRisk, minimumAdvice } = buildDecisionFloor(counts);

  return `先处理本节；后续章节只用于取证、行号和原始输出。

结论下限：
- 合并建议：${minimumAdvice}
- 总体风险：至少 ${minimumRisk}
- 风险计数：P0 >= ${counts.P0}，P1 >= ${counts.P1}，P2 >= ${counts.P2}，P3 >= ${counts.P3}

审查覆盖：
- 待判断文件数：${changedFiles.length}
- 下面每个文件都必须进入“变更摘要”，并给出一句文件级判断。
- 目录名不能作为跳过理由；只要在待判断文件中，就按实际变更审查。

待判断文件：
${buildChangedFilesBrief(changedFiles)}

必须覆盖风险：
${buildPriorityFindingsBrief(priorityFindings)}

验证状态：
${buildTestBrief(testCmd, testResult, parsedTestSummary)}
- Diff Check 退出码：${diffCheck.status}`;
}

/**
 * Detect high-priority findings that should drive the final report.
 * 中文：从结构化 diff 和测试摘要中提取必须优先进入报告的风险。
 * This section is placed before the long diff so the model sees hard findings,
 * required severity, and required report actions before lower-priority context.
 *
 * @param {string} diffText Raw unified diff.
 * @param {Set<string>} ignoredPaths Paths excluded from detection.
 * @param {object|null} parsedTestSummary Parsed test counts.
 * @returns {{severity:string,type:string,location:string,evidence:string,requiredAction:string}[]} Priority findings.
 */
function detectPriorityFindings(diffText, ignoredPaths, parsedTestSummary) {
  const records = parseDiffLineRecords(diffText, ignoredPaths);
  const findings = [];
  const seen = new Set();

  const addFinding = finding => {
    const key = finding.dedupeKey || `${finding.type}:${finding.location}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push(finding);
  };

  for (const record of records) {
    const isTestFile = /(^|\/)(test|tests|__tests__)\//i.test(record.filePath) || /\.test\.[cm]?jsx?$/i.test(record.filePath) || /\.spec\.[cm]?jsx?$/i.test(record.filePath);
    const isSourceFile = !isTestFile;

    if (record.kind !== "added") {
      continue;
    }

    const sensitive = classifySensitiveLine(record.content);
    if (sensitive && isSourceFile) {
      addFinding({
        severity: "P0",
        type: "hardcoded_sensitive_literal",
        dedupeKey: `hardcoded_sensitive_literal:${record.filePath}:${record.lineNumber}`,
        location: `${record.filePath}:${record.lineNumber}`,
        evidence: `${sensitive.label} | ${extractSensitiveValue(record.content)} | ${redactSensitiveContent(record.content.trim())}`,
        requiredAction: "必须进入关键风险、风险计数和 Top 3 候选；合并建议不得高于“不建议合并”。"
      });
    }

    if (isSourceFile && /\breturn\s+\{\s*ok:\s*true\b/.test(record.content) && /auth|login|token|permission|access/i.test(record.filePath)) {
      addFinding({
        severity: "P0",
        type: "auth_bypass",
        dedupeKey: `auth_bypass:${record.filePath}`,
        location: `${record.filePath}:${record.lineNumber}`,
        evidence: redactSensitiveContent(record.content.trim()),
        requiredAction: "必须进入关键风险和风险计数；总体风险至少 P0；合并建议必须为“不建议合并”。"
      });
    }

    if (isSourceFile && /console\.log\(/.test(record.content) && /auth|token|password|secret|authorization/i.test(record.content)) {
      addFinding({
        severity: "P1",
        type: "sensitive_auth_logging",
        dedupeKey: `sensitive_auth_logging:${record.filePath}`,
        location: `${record.filePath}:${record.lineNumber}`,
        evidence: redactSensitiveContent(record.content.trim()),
        requiredAction: "必须进入关键风险或测试建议；说明日志泄露风险。"
      });
    }

    if (/test\.skip|describe\.skip|it\.skip/.test(record.content)) {
      addFinding({
        severity: "P1",
        type: "skipped_critical_test",
        dedupeKey: `skipped_critical_test:${record.filePath}:${record.lineNumber}`,
        location: `${record.filePath}:${record.lineNumber}`,
        evidence: redactSensitiveContent(record.content.trim()),
        requiredAction: "必须进入关键风险和风险计数；测试结果必须写明跳过数量。"
      });
    }
  }

  for (const record of records) {
    const isTestFile = /(^|\/)(test|tests|__tests__)\//i.test(record.filePath) || /\.test\.[cm]?jsx?$/i.test(record.filePath) || /\.spec\.[cm]?jsx?$/i.test(record.filePath);
    const isSourceFile = !isTestFile;

    if (record.kind !== "deleted") {
      continue;
    }

    if (isSourceFile && /invalid token|missing token|unauthorized|jwtSecret|authorization/i.test(record.content)) {
      addFinding({
        severity: "P0",
        type: "auth_rejection_removed",
        dedupeKey: `auth_rejection_removed:${record.filePath}`,
        location: `${record.filePath}:${record.lineNumber} (deleted)`,
        evidence: redactSensitiveContent(record.content.trim()),
        requiredAction: "必须进入关键风险和风险计数；总体风险至少 P0。"
      });
    }

    if (isSourceFile && /invalid quantity|invalid price|Math\.min|Math\.max|coupon|quantity|unitPrice/i.test(record.content)) {
      addFinding({
        severity: "P1",
        type: "business_validation_removed",
        dedupeKey: `business_validation_removed:${record.filePath}`,
        location: `${record.filePath}:${record.lineNumber} (deleted)`,
        evidence: redactSensitiveContent(record.content.trim()),
        requiredAction: "必须进入关键风险或 Top 3 候选；说明订单金额或数据完整性风险。"
      });
    }
  }

  if (parsedTestSummary && typeof parsedTestSummary.skipped === "number" && parsedTestSummary.skipped > 0) {
    addFinding({
      severity: "P1",
      type: "test_run_has_skips",
      dedupeKey: "test_run_has_skips",
      location: "Parsed Test Summary",
      evidence: `Skipped tests = ${parsedTestSummary.skipped}`,
      requiredAction: "必须写入测试结果、关键风险或测试建议；不得描述为覆盖率。"
    });
  }

  return findings;
}

/**
 * Render priority findings or an explicit no-findings message.
 * 中文：渲染优先级风险列表；没有发现时也给出明确说明。
 * Keeping this section short and near the top makes it the primary input for
 * final report generation.
 *
 * @param {{severity:string,type:string,location:string,evidence:string,requiredAction:string}[]} findings Priority findings.
 * @returns {string} Markdown section body.
 */
function buildPriorityFindings(findings) {
  if (findings.length === 0) {
    return "No priority findings were detected by rule-based pre-scan. Review the diff and tests normally.";
  }

  return findings.map((finding, index) => formatPriorityFinding(finding, index + 1)).join("\n\n");
}

/**
 * Build minimum final-report requirements from priority findings.
 * 中文：根据优先级风险生成最低风险等级、最低合并建议和风险计数下限。
 * The final LLM report may be stricter, but it should not go below these floors.
 *
 * @param {{severity:string}[]} findings Priority findings.
 * @returns {string} Markdown requirement summary.
 */
function buildReviewDecisionFloor(findings) {
  const counts = countFindingsBySeverity(findings);
  const { minimumRisk, minimumAdvice } = buildDecisionFloor(counts);

  return `Minimum Overall Risk: ${minimumRisk}
Minimum Merge Advice: ${minimumAdvice}
Required Risk Count Floor: P0 >= ${counts.P0}, P1 >= ${counts.P1}, P2 >= ${counts.P2}, P3 >= ${counts.P3}
Rule: final report may be stricter than this floor, but must not be less strict.`;
}

/**
 * Build line-level findings for newly added sensitive literals.
 * 中文：基于新增 diff 行生成敏感字面量发现列表。
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

    if (!filePath || ignoredPaths.has(filePath) || newLine <= 0) {
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
 * 中文：判断文件是否适合用 `node --check` 做 JavaScript 语法检查。
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
 * 中文：对变更的 JavaScript 文件运行语法检查，提供语法类结论证据。
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
    .filter((filePath, index) => filePath && !changes[index].status.startsWith("D") && isJavaScriptFile(filePath));

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
 * 中文：判断文件是否适合作为文本快照读取。
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
 * 中文：读取当前文件内容并加上稳定行号，供报告引用当前代码位置。
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
 * 中文：为有限数量的变更文件生成当前文件快照，控制上下文规模。
 * Snapshots complement diff anchors by showing surrounding current code with
 * line numbers, but the file count limit prevents excessive context growth.
 *
 * @param {string} repoRoot Repository root.
 * @param {{status:string, filePath:string}[]} changes Reviewable file changes.
 * @param {object} options Runtime options containing snapshot limits.
 * @returns {string} Markdown snapshots.
 */
function buildFileSnapshots(repoRoot, changes, options) {
  const currentFileChanges = changes.filter(change => !change.status.startsWith("D"));
  const scopedChanges = currentFileChanges.slice(0, options.maxFiles);
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

  const omitted = currentFileChanges.length - scopedChanges.length;
  if (omitted > 0) {
    snapshots.push(`(${omitted} changed files omitted by --max-files)`);
  }
  return snapshots.join("\n\n");
}

/**
 * Parse Node.js test-runner summary lines.
 * 中文：解析 Node.js 测试输出中的测试总数、通过、失败、跳过等统计。
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
 * Parse a command result into structured test counts when supported.
 * 中文：从测试命令结果中提取结构化统计，供风险预扫描和摘要输出复用。
 *
 * @param {{stdout:string, stderr:string}|null} testResult Raw test command result.
 * @returns {object|null} Parsed summary counts, or null if unavailable.
 */
function parseTestSummary(testResult) {
  if (!testResult) {
    return null;
  }

  return parseNodeTestSummary(`${testResult.stdout}\n${testResult.stderr}`);
}

/**
 * Build a compact parsed test summary for the review context.
 * 中文：生成简洁的测试统计摘要，并明确 skipped 不能当作覆盖率。
 * When skipped tests are present, the warning explicitly prevents treating
 * pass/skipped ratios as coverage evidence.
 *
 * @param {{stdout:string, stderr:string}|null} testResult Raw test command result.
 * @returns {string} Parsed test summary or fallback guidance.
 */
function buildParsedTestSummary(testResult, parsedSummary = parseTestSummary(testResult)) {
  if (!testResult) {
    return "No test command was provided or detected.";
  }

  if (!parsedSummary) {
    return "No structured test summary was parsed. Use the raw Test Result section as evidence.";
  }

  const skipped = typeof parsedSummary.skipped === "number" ? parsedSummary.skipped : "unknown";
  const warning = typeof parsedSummary.skipped === "number" && parsedSummary.skipped > 0
    ? "\n\nWarning: skipped tests are not coverage. Treat skipped key tests as review risk."
    : "";

  return `Tests: ${parsedSummary.tests ?? "unknown"}
Passed: ${parsedSummary.pass ?? "unknown"}
Failed: ${parsedSummary.fail ?? "unknown"}
Skipped: ${skipped}
Todo: ${parsedSummary.todo ?? "unknown"}${warning}`;
}

/**
 * Resolve an arbitrary starting directory to its git repository root.
 * 中文：把任意起始目录解析为 Git 仓库根目录。
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
 * 中文：检查仓库是否已有 HEAD 提交，用于决定 diff 基准。
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
 * 中文：从 package.json 自动识别默认 npm 测试命令。
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
    const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8").replace(/^\uFEFF/, ""));
    return pkg.scripts && pkg.scripts.test ? "npm test" : null;
  } catch {
    return null;
  }
}

/**
 * Render a named Markdown section with consistent spacing.
 * 中文：按统一格式渲染 Markdown 区块，保持上下文结构稳定。
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
 * 中文：汇总代码审查所需的全部证据，并输出稳定的 Markdown 上下文文档。
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
  const generatedAt = new Date().toISOString();
  const staticIgnoredPathList = normalizePathList([getOwnSkillIgnoredPath(repoRoot)].filter(Boolean));

  const branch = runGit(["branch", "--show-current"], repoRoot);
  const status = runGit(buildScopedGitArgs(["status", "--short", "--branch"], staticIgnoredPathList), repoRoot);
  const untracked = runGit(buildScopedGitArgs(["ls-files", "--others", "--exclude-standard"], staticIgnoredPathList), repoRoot);
  const nameStatus = runGit(buildDiffArgs(base, ["--name-status"], staticIgnoredPathList), repoRoot);
  const parsedChangedFiles = parseNameStatusLines(nameStatus.stdout);
  const { changes: trackedChanges, ignoredChanges } = splitChangedFiles(parsedChangedFiles, repoRoot);
  const { changes: untrackedChanges, ignoredChanges: ignoredUntrackedChanges } = splitUntrackedFiles(untracked.stdout, repoRoot);
  const changedFiles = mergeChangeRecords(trackedChanges, untrackedChanges);
  const changedFilesResult = combineCommandResults(nameStatus, {
    status: 0,
    stdout: untrackedChanges.map(change => `${change.status}\t${change.filePath}`).join("\n"),
    stderr: "",
    error: ""
  });
  const changedFilesCommand = untrackedChanges.length > 0
    ? `${buildDiffCommand(base, ["--name-status"], staticIgnoredPathList)} + ${buildScopedGitCommand(["ls-files", "--others", "--exclude-standard"], staticIgnoredPathList)}`
    : buildDiffCommand(base, ["--name-status"], staticIgnoredPathList);
  const ignoredPathList = normalizePathList([
    ...staticIgnoredPathList,
    ...ignoredChanges.map(change => change.filePath),
    ...ignoredUntrackedChanges.map(change => change.filePath)
  ]);
  const ignoredPaths = new Set(ignoredPathList);
  const trackedDiffStat = runGit(buildDiffArgs(base, ["--stat"], ignoredPathList), repoRoot);
  const untrackedDiffStat = buildUntrackedStat(repoRoot, untrackedChanges);
  const diffStat = combineCommandResults(trackedDiffStat, untrackedDiffStat);
  const diffStatCommand = untrackedChanges.length > 0
    ? `${buildDiffCommand(base, ["--stat"], ignoredPathList)} + untracked-file stat`
    : buildDiffCommand(base, ["--stat"], ignoredPathList);
  const trackedDiffCheck = runGit(buildDiffArgs(base, ["--check"], ignoredPathList), repoRoot);
  const untrackedDiffCheck = buildUntrackedDiffCheck(repoRoot, untrackedChanges);
  const diffCheck = combineCommandResults(trackedDiffCheck, untrackedDiffCheck);
  const diffCheckCommand = untrackedChanges.length > 0
    ? `${buildDiffCommand(base, ["--check"], ignoredPathList)} + untracked-file whitespace check`
    : buildDiffCommand(base, ["--check"], ignoredPathList);
  const trackedDiff = runGit(buildDiffArgs(base, [], ignoredPathList), repoRoot);
  const untrackedDiff = buildUntrackedDiff(repoRoot, untrackedChanges);
  const fullDiff = combineDiffResults(trackedDiff, untrackedDiff);
  const fullDiffCommand = untrackedChanges.length > 0
    ? `${buildDiffCommand(base, [], ignoredPathList)} + synthetic untracked-file diff`
    : buildDiffCommand(base, [], ignoredPathList);

  const testCmd = options.noTests ? null : options.testCmd || detectDefaultTestCommand(repoRoot);
  const testResult = testCmd ? run(testCmd, [], repoRoot, true) : null;
  const parsedTestSummary = parseTestSummary(testResult);
  const priorityFindings = detectPriorityFindings(fullDiff.stdout || "", ignoredPaths, parsedTestSummary);

  const parts = [];
  parts.push(`# CodeFlow Guard Review Context

Generated: ${generatedAt}
Repository: ${repoRoot}
Branch: ${branch.stdout.trim() || "(detached or unknown)"}
Diff base: ${base || "(no HEAD; working tree diff only)"}
${buildReviewScopeSummary(ignoredPathList)}
`);

  parts.push(section("Review Brief", buildReviewBrief({
    changedFiles,
    priorityFindings,
    testCmd,
    testResult,
    parsedTestSummary,
    diffCheck
  })));

  if (options.briefOnly) {
    process.stdout.write(parts.join("\n"));
    return;
  }

  parts.push(section("Report Contract", buildReportContract(testCmd)));
  parts.push(section("Review Decision Floor", buildReviewDecisionFloor(priorityFindings)));
  parts.push(section("Priority Findings", buildPriorityFindings(priorityFindings)));
  parts.push(section("Repository State", commandBlock(buildScopedGitCommand(["status", "--short", "--branch"], staticIgnoredPathList), status)));
  parts.push(section("Changed Files", buildChangedFilesSection(changedFilesCommand, changedFilesResult, changedFiles, [...ignoredChanges, ...ignoredUntrackedChanges])));
  parts.push(section("Untracked Files", commandBlock(buildScopedGitCommand(["ls-files", "--others", "--exclude-standard"], staticIgnoredPathList), untracked)));
  parts.push(section("Diff Stat", commandBlock(diffStatCommand, diffStat)));
  parts.push(section("Diff Check", commandBlock(diffCheckCommand, diffCheck)));
  parts.push(section("Syntax Check", buildSyntaxCheck(repoRoot, changedFiles)));
  parts.push(section("Sensitive Literal Findings", buildSensitiveLiteralFindings(fullDiff.stdout || "", ignoredPaths)));
  parts.push(section("Changed Line Anchors", buildChangedLineAnchors(fullDiff.stdout || "", options.maxAnchors, ignoredPaths)));

  const diffOutput = truncate(redactText(fullDiff.stdout || fullDiff.stderr || "(no diff)"), options.maxDiffChars);
  parts.push(section("Full Diff", `Command: ${fullDiffCommand}
Exit code: ${fullDiff.status}

\`\`\`diff
${diffOutput}
\`\`\``));

  parts.push(section("Current File Snapshots", buildFileSnapshots(repoRoot, changedFiles, options)));

  if (testResult) {
    parts.push(section("Test Result", commandBlock(testCmd, testResult)));
    parts.push(section("Parsed Test Summary", buildParsedTestSummary(testResult, parsedTestSummary)));
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
