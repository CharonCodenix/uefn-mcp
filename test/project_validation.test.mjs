import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectUefnProjectPath } from "../src/lib/project.mjs";

test("identifies a UEFN project root before analysis", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-project-"));
  await fs.mkdir(path.join(root, "Content"));
  await fs.mkdir(path.join(root, ".urc"));
  await fs.writeFile(path.join(root, "Sample.uefnproject"), JSON.stringify({
    title: "Sample",
    compatibilityVersion: 40,
    plugins: [{ name: "Sample", bIsRoot: true }],
    dataSets: {
      experimental: {
        pythonExperimental: {
          bEnablePythonForProject: true
        }
      }
    }
  }));
  await fs.writeFile(path.join(root, "Sample.uplugin"), JSON.stringify({
    VersePath: "/Sample"
  }));

  const inspection = await inspectUefnProjectPath(root);

  assert.equal(inspection.safeToAnalyze, true);
  assert.equal(inspection.projectName, "Sample");
  assert.equal(inspection.rootPluginName, "Sample");
  assert.equal(inspection.pythonEnabled, true);
  assert.equal(inspection.hasUnrealRevisionControl, true);
  assert.deepEqual(inspection.errors, []);
});

test("rejects folders that do not look like UEFN project roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-not-project-"));
  await fs.mkdir(path.join(root, ".urc"));

  const inspection = await inspectUefnProjectPath(root);

  assert.equal(inspection.safeToAnalyze, false);
  assert.match(inspection.errors.join("\n"), /\.uefnproject/);
  assert.match(inspection.errors.join("\n"), /Content/);
});

test("treats missing .urc as an optional warning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-no-urc-"));
  await fs.mkdir(path.join(root, "Content"));
  await fs.writeFile(path.join(root, "Sample.uefnproject"), JSON.stringify({
    title: "Sample",
    plugins: [{ name: "Sample", bIsRoot: true }]
  }));
  await fs.writeFile(path.join(root, "Sample.uplugin"), JSON.stringify({}));

  const inspection = await inspectUefnProjectPath(root);

  assert.equal(inspection.safeToAnalyze, true);
  assert.equal(inspection.hasUnrealRevisionControl, false);
  assert.match(inspection.warnings.join("\n"), /\.urc was not found/);
});

test("rejects projects missing Content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-missing-content-"));
  await fs.writeFile(path.join(root, "Sample.uefnproject"), JSON.stringify({
    title: "Sample",
    plugins: [{ name: "Sample", bIsRoot: true }]
  }));
  await fs.writeFile(path.join(root, "Sample.uplugin"), JSON.stringify({}));

  const inspection = await inspectUefnProjectPath(root);

  assert.equal(inspection.safeToAnalyze, false);
  assert.match(inspection.errors.join("\n"), /Content directory/);
});

test("rejects projects with multiple .uefnproject files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-multiple-projects-"));
  await fs.mkdir(path.join(root, "Content"));
  await fs.writeFile(path.join(root, "One.uefnproject"), JSON.stringify({}));
  await fs.writeFile(path.join(root, "Two.uefnproject"), JSON.stringify({}));

  const inspection = await inspectUefnProjectPath(root);

  assert.equal(inspection.safeToAnalyze, false);
  assert.match(inspection.errors.join("\n"), /found 2/);
});
