const path = require("node:path");

/**
 * Return a normalized extension for a repository-relative file path.
 * 中文：读取仓库相对路径的扩展名并统一为小写，便于语言适配匹配。
 *
 * @param {string} filePath Repository-relative path.
 * @returns {string} Lowercase extension (including leading dot) or empty string.
 */
function getExtension(filePath) {
  return path.extname(String(filePath || "")).toLowerCase();
}

/**
 * Remove quotes and trailing commas from an import-like token.
 * 中文：清理 import 片段里的引号和逗号，避免正则匹配后的噪声影响路径解析。
 *
 * @param {string} rawSpecifier Raw specifier matched from source code.
 * @returns {string} Cleaned import-like specifier.
 */
function cleanSpecifier(rawSpecifier) {
  return String(rawSpecifier || "").trim().replace(/^["']|["'],?$/g, "");
}

/**
 * Check whether a path extension belongs to one of the given sets.
 * 中文：判断路径扩展名是否命中指定扩展集合。
 *
 * @param {string} filePath Repository-relative path.
 * @param {Set<string>} extensionSet Lowercase extension set.
 * @returns {boolean} True when extension is covered.
 */
function hasExtension(filePath, extensionSet) {
  return extensionSet.has(getExtension(filePath));
}

const JS_FAMILY_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
const PYTHON_EXTENSIONS = new Set([".py"]);

const SIGNAL_SCAN_EXTENSIONS = new Set([
  ".cjs", ".env", ".go", ".java", ".js", ".json", ".jsx", ".mjs",
  ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".yaml", ".yml"
]);

/**
 * Decide whether a file should participate in lightweight signal scanning.
 * 中文：决定文件是否进入轻量信号扫描；只做证据收集，不做风险判定。
 *
 * @param {string} filePath Repository-relative path.
 * @returns {boolean} True when scan is useful.
 */
function shouldScanSignals(filePath) {
  return hasExtension(filePath, SIGNAL_SCAN_EXTENSIONS);
}

/**
 * Return candidate file names for resolving relative JS/TS imports.
 * 中文：为 JS/TS 相对引用生成候选文件名（含 index 入口）。
 *
 * @param {string} basePath Repository-relative path without extension.
 * @returns {string[]} Candidate repository-relative file paths.
 */
function getJavaScriptCandidates(basePath) {
  return [
    basePath,
    `${basePath}.js`,
    `${basePath}.cjs`,
    `${basePath}.mjs`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.jsx`,
    `${basePath}/index.js`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
    `${basePath}/index.jsx`
  ];
}

/**
 * Return candidate file names for resolving relative Python imports.
 * 中文：为 Python 相对引用生成候选文件名（模块与包入口）。
 *
 * @param {string} basePath Repository-relative module path.
 * @returns {string[]} Candidate repository-relative file paths.
 */
function getPythonCandidates(basePath) {
  return [
    `${basePath}.py`,
    `${basePath}/__init__.py`
  ];
}

/**
 * Extract relative-reference hints from JS/TS source code.
 * 中文：从 JS/TS 源码提取相对 import/require/export-from 线索。
 *
 * @param {string} content Source text.
 * @returns {string[]} Relative import-like specifiers.
 */
function extractJavaScriptRelativeSpecifiers(content) {
  const specifiers = [];
  const patterns = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      const specifier = cleanSpecifier(match[1]);
      if (specifier.startsWith(".")) {
        specifiers.push(specifier);
      }
      match = pattern.exec(content);
    }
  }

  return specifiers;
}

/**
 * Extract relative-import hints from Python source code.
 * 中文：从 Python 源码提取相对 import 线索（from .x import y / from ..x import y）。
 *
 * @param {string} content Source text.
 * @returns {string[]} Relative module specifiers represented with leading dots.
 */
function extractPythonRelativeSpecifiers(content) {
  const specifiers = [];
  const pattern = /\bfrom\s+(\.+[A-Za-z0-9_\.]*)\s+import\b/g;
  let match = pattern.exec(content);
  while (match) {
    const specifier = cleanSpecifier(match[1]);
    if (specifier.startsWith(".")) {
      specifiers.push(specifier);
    }
    match = pattern.exec(content);
  }
  return specifiers;
}

/**
 * Convert a Python relative module specifier to a repository-relative base path.
 * 中文：把 Python 的相对模块引用转换为仓库相对基础路径（不带扩展名）。
 *
 * @param {string} fromFile Repository-relative source file.
 * @param {string} specifier Relative Python module specifier.
 * @returns {string|null} Repository-relative base path or null when invalid.
 */
function resolvePythonModuleBase(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const dotPrefixMatch = specifier.match(/^(\.+)/);
  const dotCount = dotPrefixMatch ? dotPrefixMatch[1].length : 0;
  if (dotCount <= 0) {
    return null;
  }

  const fromDir = path.dirname(fromFile);
  const directoryParts = fromDir.split("/").filter(Boolean);
  const upLevels = Math.max(dotCount - 1, 0);
  if (upLevels > directoryParts.length) {
    return null;
  }

  const targetParts = directoryParts.slice(0, directoryParts.length - upLevels);
  const remainder = specifier.slice(dotCount);
  if (remainder) {
    targetParts.push(...remainder.split(".").filter(Boolean));
  }

  return targetParts.join("/");
}

/**
 * Build reference-resolution work items for a single file.
 * 中文：根据文件类型构建“引用提取 + 候选路径生成”任务，供主脚本解析现存文件。
 *
 * @param {string} filePath Repository-relative file path.
 * @param {string} content Source text.
 * @returns {{specifier:string,candidates:string[]}[]} Reference work items.
 */
function collectRelativeReferencePlans(filePath, content) {
  if (hasExtension(filePath, JS_FAMILY_EXTENSIONS)) {
    return extractJavaScriptRelativeSpecifiers(content).map(specifier => ({
      specifier,
      candidates: getJavaScriptCandidates(path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier)))
    }));
  }

  if (hasExtension(filePath, PYTHON_EXTENSIONS)) {
    return extractPythonRelativeSpecifiers(content)
      .map(specifier => {
        const base = resolvePythonModuleBase(filePath, specifier);
        return base ? { specifier, candidates: getPythonCandidates(base) } : null;
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Build a non-mutating syntax-check plan for one file when supported.
 * 中文：为单文件生成“只读、不改数据”的语法检查计划；不支持时返回 null。
 *
 * @param {string} filePath Repository-relative path.
 * @returns {{command:string,args:string[],display:string}|null}
 */
function buildSyntaxCheckPlan(filePath) {
  const ext = getExtension(filePath);

  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return {
      command: "node",
      args: ["--check", filePath],
      display: `node --check ${filePath}`
    };
  }

  if (ext === ".py") {
    return {
      command: "python",
      args: [
        "-c",
        "import ast, pathlib, sys; p=pathlib.Path(sys.argv[1]); ast.parse(p.read_text(encoding='utf-8'), filename=str(p))",
        filePath
      ],
      display: `python -c "ast.parse(...)" ${filePath}`
    };
  }

  if (ext === ".rb") {
    return {
      command: "ruby",
      args: ["-wc", filePath],
      display: `ruby -wc ${filePath}`
    };
  }

  if (ext === ".php") {
    return {
      command: "php",
      args: ["-l", filePath],
      display: `php -l ${filePath}`
    };
  }

  if (ext === ".sh") {
    return {
      command: "bash",
      args: ["-n", filePath],
      display: `bash -n ${filePath}`
    };
  }

  return null;
}

/**
 * Parse test summary counts from common test-runner outputs.
 * 中文：从常见测试输出里提取通过/失败/跳过统计（仅收集数据，不做风险结论）。
 *
 * @param {string} output Combined stdout/stderr from test execution.
 * @returns {{tests?:number,pass?:number,fail?:number,skipped?:number,todo?:number}|null}
 */
function parseTestSummary(output) {
  const text = String(output || "");
  const summary = {};

  const apply = (key, pattern) => {
    const match = text.match(pattern);
    if (match) {
      summary[key] = Number(match[1]);
    }
  };

  // Node test runner.
  apply("tests", /[ℹ#]\s*tests\s+(\d+)/i);
  apply("pass", /[ℹ#]\s*(?:pass|passed)\s+(\d+)/i);
  apply("fail", /[ℹ#]\s*(?:fail|failed)\s+(\d+)/i);
  apply("skipped", /[ℹ#]\s*(?:skipped|skip)\s+(\d+)/i);
  apply("todo", /[ℹ#]\s*todo\s+(\d+)/i);

  // pytest / nose-like summary.
  apply("pass", /(\d+)\s+passed\b/i);
  apply("fail", /(\d+)\s+failed\b/i);
  apply("skipped", /(\d+)\s+skipped\b/i);

  // JUnit / Surefire-style summary.
  const testsRunMatch = text.match(/Tests run:\s*(\d+)/i);
  const failuresMatch = text.match(/Failures:\s*(\d+)/i);
  const errorsMatch = text.match(/Errors:\s*(\d+)/i);
  const skippedMatch = text.match(/Skipped:\s*(\d+)/i);
  if (testsRunMatch) {
    summary.tests = Number(testsRunMatch[1]);
  }
  if (failuresMatch || errorsMatch) {
    summary.fail = (failuresMatch ? Number(failuresMatch[1]) : 0) + (errorsMatch ? Number(errorsMatch[1]) : 0);
  }
  if (skippedMatch) {
    summary.skipped = Number(skippedMatch[1]);
  }

  if (typeof summary.tests === "number" && typeof summary.pass !== "number" && typeof summary.fail === "number") {
    const skipped = typeof summary.skipped === "number" ? summary.skipped : 0;
    summary.pass = Math.max(summary.tests - summary.fail - skipped, 0);
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * Detect whether a line indicates an intentionally skipped test.
 * 中文：识别常见语言/框架中的“跳过测试”标记，作为测试风险线索来源。
 *
 * @param {string} line Source line.
 * @returns {boolean} True when line looks like skip marker.
 */
function isSkippedTestMarker(line) {
  const text = String(line || "");
  return /test\.skip|describe\.skip|it\.skip|@pytest\.mark\.skip|pytest\.skip\(|@unittest\.skip|\.Skip\(|@Disabled/i.test(text);
}

module.exports = {
  buildSyntaxCheckPlan,
  collectRelativeReferencePlans,
  isSkippedTestMarker,
  parseTestSummary,
  shouldScanSignals
};

