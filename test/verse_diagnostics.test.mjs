import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { parseVerseDiagnosticLine, parseVerseDiagnostics, resolveAllowedLogPath } from "../src/lib/verse_diagnostics.mjs";

test("parses Verse diagnostic lines", () => {
  const line = "VerseBuild: Error: C:\\Project\\Content\\foo.verse(12,8, 12,15): Script error 3506: Unknown identifier Bar";
  const diagnostic = parseVerseDiagnosticLine(line, 42);

  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.file, "C:/Project/Content/foo.verse");
  assert.equal(diagnostic.startLine, 12);
  assert.equal(diagnostic.startColumn, 8);
  assert.equal(diagnostic.code, "3506");
  assert.equal(diagnostic.message, "Unknown identifier Bar");
});

test("summarizes Verse diagnostics and compile summaries", () => {
  const log = [
    "noise",
    "VerseBuild: Warning: C:\\Project\\Content\\foo.verse(2,1, 2,3): Script warning 9999: Careful",
    "VerseBuild: Error: C:\\Project\\Content\\foo.verse(3,1, 3,3): Script error 3506: Broken",
    "LogSolLoadCompiler: Display: Global Verse compile (full, 14 packages compiled in 123.45 ms) finished: FAILED"
  ].join("\n");

  const result = parseVerseDiagnostics(log, { maxDiagnostics: 10, logPath: "test.log" });

  assert.equal(result.ok, true);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
  assert.equal(result.summary.latestStatus, "FAILED");
  assert.equal(result.diagnostics.length, 2);
});

test("restricts custom log paths to the configured UEFN log or project logs", () => {
  const root = path.join(os.tmpdir(), "uefn-mcp-log-test");
  const config = {
    projectPath: path.join(root, "Project"),
    uefnLogPath: path.join(root, "UnrealEditorFortnite.log"),
    allowExternalLogPath: false
  };
  const projectLog = path.join(config.projectPath, "Saved", "Logs", "Project.log");
  const externalLog = path.join(root, "Other", "Secret.log");

  assert.equal(resolveAllowedLogPath({}, config), path.resolve(config.uefnLogPath));
  assert.equal(resolveAllowedLogPath({ logPath: config.uefnLogPath }, config), path.resolve(config.uefnLogPath));
  assert.equal(resolveAllowedLogPath({ logPath: projectLog }, config), path.resolve(projectLog));
  assert.throws(() => resolveAllowedLogPath({ logPath: externalLog }, config), /Custom logPath is disabled/);
});
