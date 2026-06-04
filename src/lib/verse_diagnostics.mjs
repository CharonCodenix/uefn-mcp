import fs from "node:fs/promises";
import path from "node:path";
import { clampInteger } from "./config.mjs";

export async function readVerseDiagnostics(args = {}, defaultLogPath) {
  const logPath = resolveAllowedLogPath(args, defaultLogPath);
  const maxDiagnostics = clampInteger(args.maxDiagnostics ?? 20, 1, 500, "maxDiagnostics");
  const sinceLine = args.sinceLine === undefined
    ? 1
    : clampInteger(args.sinceLine, 1, Number.MAX_SAFE_INTEGER, "sinceLine");
  const includeRaw = args.includeRaw === true;
  const compact = args.compact !== false;
  const content = await fs.readFile(logPath, "utf8");
  return parseVerseDiagnostics(content, {
    logPath,
    sinceLine,
    maxDiagnostics,
    includeRaw,
    compact
  });
}

export async function tailLog(args = {}, defaultLogPath) {
  const lines = clampInteger(args.lines ?? 120, 1, 2000, "lines");
  const logPath = resolveAllowedLogPath(args, defaultLogPath);
  const filter = args.filter ?? "verse_build";
  const content = await fs.readFile(logPath, "utf8");
  const allLines = content.split(/\r?\n/);
  const numbered = allLines.map((text, index) => ({ line: index + 1, text }));
  const filtered = filter === "verse_build"
    ? numbered.filter((line) => isVerseBuildSignalLine(line.text) || parseVerseCompileSummaryLine(line.text, line.line, false))
    : numbered;
  const selected = filtered.slice(-lines);

  return {
    ok: true,
    logPath,
    filter,
    totalLines: allLines.length,
    matchedLines: filtered.length,
    startLine: selected[0]?.line ?? null,
    lines: selected
  };
}

export function resolveAllowedLogPath(args = {}, configOrDefaultLogPath) {
  const config = typeof configOrDefaultLogPath === "object" && configOrDefaultLogPath !== null
    ? configOrDefaultLogPath
    : null;
  const defaultLogPath = config?.uefnLogPath ?? configOrDefaultLogPath;
  const requestedLogPath = args.logPath ?? defaultLogPath;
  const resolved = path.resolve(requestedLogPath);

  if (!args.logPath || !config) {
    return resolved;
  }

  const defaultResolved = path.resolve(defaultLogPath);
  const projectLogRoot = path.resolve(config.projectPath, "Saved", "Logs");
  const isDefaultLog = resolved.toLowerCase() === defaultResolved.toLowerCase();
  const isProjectLog = isPathInside(projectLogRoot, resolved) && path.extname(resolved).toLowerCase() === ".log";
  if (config.allowExternalLogPath === true || isDefaultLog || isProjectLog) {
    return resolved;
  }

  throw new Error(
    "Custom logPath is disabled unless it is the configured UEFN log, a .log file under the configured project's Saved/Logs folder, " +
    "or allowExternalLogPath=true is set in uefn-mcp.config.json / UEFN_MCP_ALLOW_EXTERNAL_LOG_PATH=true."
  );
}

export function parseVerseDiagnostics(content, options = {}) {
  const sinceLine = options.sinceLine ?? 1;
  const maxDiagnostics = options.maxDiagnostics ?? 20;
  const includeRaw = options.includeRaw === true;
  const compact = options.compact !== false;
  const allLines = content.split(/\r?\n/);
  const lines = allLines.slice(sinceLine - 1);
  const diagnostics = [];
  const summaries = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const lineNumber = sinceLine + index;
    const diagnostic = parseVerseDiagnosticLine(text, lineNumber, includeRaw);
    if (diagnostic) {
      const key = [
        diagnostic.file ?? "",
        diagnostic.startLine ?? "",
        diagnostic.startColumn ?? "",
        diagnostic.code ?? "",
        diagnostic.message
      ].join("|");
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
      continue;
    }

    const summary = parseVerseCompileSummaryLine(text, lineNumber, includeRaw);
    if (summary) {
      summaries.push(summary);
    }
  }

  const selectedDiagnostics = diagnostics.slice(-maxDiagnostics);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const latestSummary = summaries.at(-1) ?? null;
  const result = {
    ok: true,
    logPath: options.logPath ?? null,
    inspectedFromLine: sinceLine,
    totalLines: allLines.length,
    diagnosticCount: diagnostics.length,
    errorCount,
    warningCount,
    latestSummary,
    summary: {
      latestStatus: latestSummary?.status ?? null,
      latestSummaryLine: latestSummary?.logLine ?? null,
      errors: errorCount,
      warnings: warningCount,
      returnedDiagnostics: selectedDiagnostics.length
    },
    diagnostics: selectedDiagnostics
  };

  if (!compact) {
    result.summaries = summaries.slice(-10);
  }

  return result;
}

export function isVerseBuildSignalLine(text) {
  return /VerseBuild:\s+(Error|Warning):/.test(text);
}

export function parseVerseDiagnosticLine(text, logLine, includeRaw = false) {
  const match = text.match(/VerseBuild:\s+(Error|Warning):\s+(.+?)\((\d+),(\d+),\s*(\d+),(\d+)\)\s*:?\s*(Script (?:error|warning) (\d+):\s*)?(.+)$/);
  if (!match) {
    return null;
  }

  return {
    logLine,
    severity: match[1].toLowerCase(),
    file: normalizeSlashes(match[2].trim()),
    startLine: Number(match[3]),
    startColumn: Number(match[4]),
    endLine: Number(match[5]),
    endColumn: Number(match[6]),
    code: match[8] ?? null,
    message: match[9].trim(),
    ...(includeRaw ? { raw: text } : {})
  };
}

export function parseVerseCompileSummaryLine(text, logLine, includeRaw = false) {
  const match = text.match(/LogSolLoadCompiler:\s+Display:\s+Global Verse compile \((.+?),\s+(\d+) packages? compiled in ([\d.]+) ms\) finished:\s+(SUCCESS|FAILED)/);
  if (!match) {
    return null;
  }

  return {
    logLine,
    mode: match[1],
    packagesCompiled: Number(match[2]),
    elapsedMs: Number(match[3]),
    status: match[4],
    ...(includeRaw ? { raw: text } : {})
  };
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
