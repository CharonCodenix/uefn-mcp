import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildIntroBanner,
  buildLocalConfig,
  claudeMcpJson,
  codexMcpBlock,
  assertSafeInstallTargets,
  detectPluginCollisions,
  ensurePnpmWithIO,
  nodeRuntimeStatus,
  RollbackManager,
  upsertCodexMcpBlock
} from "../scripts/guided_install.mjs";

test("intro banner is large ASCII art for UEFN MCP", () => {
  const banner = buildIntroBanner();
  const text = banner.join("\n");

  assert.equal(banner.length, 9);
  assert.match(text, /####/);
  assert.equal([...text].every((char) => char.charCodeAt(0) < 128), true);
});

test("upserts only the Codex uefn-mcp block", () => {
  const root = "C:\\Tools\\uefn-mcp";
  const existing = [
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.other]",
    "command = \"node\"",
    "",
    "[mcp_servers.uefn-mcp]",
    "command = \"old\"",
    "args = [\"old\"]",
    "",
    "[features]",
    "fast_mode = true",
    ""
  ].join("\n");

  const next = upsertCodexMcpBlock(existing, root);

  assert.match(next, /model = "gpt-5"/);
  assert.match(next, /\[mcp_servers\.other\]/);
  assert.match(next, /\[features\]/);
  assert.doesNotMatch(next, /command = "old"/);
  assert.equal((next.match(/\[mcp_servers\."uefn-mcp"\]/g) ?? []).length, 1);
});

test("upsert preserves TOML array tables after the old Codex block", () => {
  const root = "C:\\Tools\\uefn-mcp";
  const existing = [
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.\"uefn-mcp\"]",
    "command = \"old\"",
    "",
    "[[profiles]]",
    "name = \"work\"",
    ""
  ].join("\n");

  const next = upsertCodexMcpBlock(existing, root);

  assert.match(next, /\[\[profiles\]\]/);
  assert.match(next, /name = "work"/);
  assert.doesNotMatch(next, /command = "old"/);
  assert.equal((next.match(/\[mcp_servers\."uefn-mcp"\]/g) ?? []).length, 1);
});

test("Codex block escapes Windows paths", () => {
  const block = codexMcpBlock("C:\\Users\\Test User\\uefn-mcp");

  assert.match(block, /args = \["C:\\\\Users\\\\Test User\\\\uefn-mcp\\\\src\\\\server\.mjs"\]/);
  assert.match(block, /cwd = "C:\\\\Users\\\\Test User\\\\uefn-mcp"/);
});

test("Claude MCP JSON uses stdio with project environment paths", () => {
  const root = "C:\\Tools\\uefn-mcp";
  const project = "C:\\Fortnite Projects\\Island";
  const config = claudeMcpJson(root, project);

  assert.equal(config.type, "stdio");
  assert.equal(config.command, "node");
  assert.equal(config.args.length, 1);
  assert.match(config.args[0], /src[\\/]server\.mjs$/);
  assert.equal(config.env.UEFN_PROJECT_PATH, path.resolve(project));
  assert.equal(config.env.UEFN_CONTENT_PATH, path.join(path.resolve(project), "Content"));
});

test("local config points to the project and Content directory", () => {
  const project = "C:\\Fortnite Projects\\Island";
  const config = buildLocalConfig(project);

  assert.equal(config.uefnProjectPath, path.resolve(project));
  assert.equal(config.contentPath, path.join(path.resolve(project), "Content"));
  assert.equal(config.bridgeUrl, "http://127.0.0.1:8765");
});

test("detects managed plugin file collisions without flagging unrelated files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-collisions-"));
  const pythonRoot = path.join(root, "Content", "Python");
  const packageDir = path.join(pythonRoot, "uefn_mcp_bridge");
  const launcher = path.join(pythonRoot, "start_uefn_mcp_bridge.py");
  await fs.mkdir(path.join(pythonRoot, "other_plugin"), { recursive: true });

  assert.deepEqual(await detectPluginCollisions(packageDir, launcher), []);

  await fs.mkdir(packageDir);
  await fs.writeFile(launcher, "");
  const collisions = await detectPluginCollisions(packageDir, launcher);

  assert.deepEqual(collisions.sort(), [launcher, packageDir].sort());
});

test("installer refuses Content/Python symlinks when the filesystem allows them", async (t) => {
  const project = await makeInstallProject();
  const outsidePython = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-outside-python-"));
  const targetPythonRoot = path.join(project.contentPath, "Python");
  try {
    await fs.symlink(outsidePython, targetPythonRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlinks unavailable in this environment: ${error.code ?? error.message}`);
    return;
  }

  await assert.rejects(
    assertSafeInstallTargets(project, {
      targetPythonRoot,
      targetPackageDir: path.join(targetPythonRoot, "uefn_mcp_bridge"),
      targetLauncher: path.join(targetPythonRoot, "start_uefn_mcp_bridge.py"),
      targetInit: path.join(targetPythonRoot, "init_unreal.py")
    }),
    /symlink|junction/
  );
});

test("runtime status rejects old Node versions", () => {
  assert.equal(nodeRuntimeStatus("v18.19.0").ok, false);
  assert.equal(nodeRuntimeStatus("v20.0.0").ok, true);
});

test("pnpm prerequisite accepts existing pnpm", async () => {
  const result = await ensurePnpmWithIO(mockPrereqIO({
    commands: { pnpm: true }
  }));

  assert.equal(result.method, "already_available");
});

test("pnpm prerequisite can recover with Corepack", async () => {
  const result = await ensurePnpmWithIO(mockPrereqIO({
    commands: { pnpm: false, corepack: true },
    answers: [true],
    afterCommand: {
      "corepack prepare pnpm@11.1.3 --activate": { pnpm: true }
    }
  }));

  assert.equal(result.method, "corepack");
});

test("pnpm prerequisite can recover with npm fallback", async () => {
  const result = await ensurePnpmWithIO(mockPrereqIO({
    commands: { pnpm: false, corepack: false, npm: true },
    answers: [true, true],
    afterCommand: {
      "npm install -g pnpm": { pnpm: true }
    }
  }));

  assert.equal(result.method, "npm");
});

test("pnpm prerequisite stops when user declines install", async () => {
  await assert.rejects(
    ensurePnpmWithIO(mockPrereqIO({
      commands: { pnpm: false, corepack: true },
      answers: [false]
    })),
    /pnpm is required/
  );
});

test("rollback restores modified files and removes new files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-rollback-"));
  const existingFile = path.join(root, "existing.txt");
  const newFile = path.join(root, "new.txt");
  await fs.writeFile(existingFile, "before", "utf8");

  const rollback = new RollbackManager();
  await rollback.prepare();
  await rollback.capture(existingFile);
  await rollback.capture(newFile);
  await fs.writeFile(existingFile, "after", "utf8");
  await fs.writeFile(newFile, "created", "utf8");

  await rollback.rollback(new Error("test failure"));

  assert.equal(await fs.readFile(existingFile, "utf8"), "before");
  await assert.rejects(fs.access(newFile), /ENOENT/);
});

function mockPrereqIO(options = {}) {
  const state = { ...(options.commands ?? {}) };
  const answers = [...(options.answers ?? [])];
  const afterCommand = options.afterCommand ?? {};

  return {
    assumeYes: false,
    ask: async (_question, defaultYes) => answers.length > 0 ? answers.shift() : defaultYes,
    commandCanRun: async (command) => state[command] === true,
    runCommand: async (command, args) => {
      Object.assign(state, afterCommand[[command, ...args].join(" ")] ?? {});
      return { exitCode: state[command] === false ? 1 : 0 };
    },
    log: () => {}
  };
}

test("rollback restores replaced directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-rollback-dir-"));
  const dir = path.join(root, "plugin");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "old.py"), "old", "utf8");

  const rollback = new RollbackManager();
  await rollback.prepare();
  await rollback.capture(dir);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "new.py"), "new", "utf8");

  await rollback.rollback(new Error("test failure"));

  assert.equal(await fs.readFile(path.join(dir, "old.py"), "utf8"), "old");
  await assert.rejects(fs.access(path.join(dir, "new.py")), /ENOENT/);
});

async function makeInstallProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-install-project-"));
  const contentPath = path.join(projectPath, "Content");
  await fs.mkdir(contentPath);
  return {
    projectPath,
    contentPath
  };
}
