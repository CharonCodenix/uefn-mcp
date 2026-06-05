import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RollbackManager, codexMcpBlock } from "../scripts/guided_install.mjs";
import { buildThankYouBanner } from "../scripts/guided_uninstall.mjs";
import {
  MANAGED_INIT_BLOCK,
  applyGuidedUninstallPlan,
  buildProjectUninstallPlan,
  planCodexUninstall,
  removeCodexMcpBlockForRepo,
  removeManagedInitBlockText
} from "../scripts/uninstall_helpers.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const sourcePythonRoot = path.join(repoRoot, "uefn-plugin", "Content", "Python");

test("thank-you banner is large ASCII art", () => {
  const banner = buildThankYouBanner();
  const text = banner.join("\n");

  assert.equal(banner.length >= 9, true);
  assert.match(text, /THANK/i);
  assert.match(text, /YOU/i);
  assert.equal([...text].every((char) => char.charCodeAt(0) < 128), true);
});

test("removes only this clone's Codex MCP block", () => {
  const root = path.join(os.tmpdir(), "uefn-mcp-current");
  const otherRoot = path.join(os.tmpdir(), "uefn-mcp-other");
  const existing = [
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.other]",
    "command = \"node\"",
    "",
    codexMcpBlock(root),
    "",
    "[features]",
    "fast_mode = true",
    ""
  ].join("\n");

  const next = removeCodexMcpBlockForRepo(existing, root);
  assert.equal(next.changed, true);
  assert.doesNotMatch(next.next, /\[mcp_servers\."uefn-mcp"\]/);
  assert.match(next.next, /\[mcp_servers\.other\]/);
  assert.match(next.next, /\[features\]/);

  const refused = removeCodexMcpBlockForRepo(codexMcpBlock(otherRoot), root);
  assert.equal(refused.changed, false);
  assert.equal(refused.foundOtherRepoBlock, true);
  assert.match(refused.next, /\[mcp_servers\."uefn-mcp"\]/);
});

test("project uninstall planner refuses package paths outside the project Content/Python folder", async () => {
  const project = await makeTempProject();
  const outsideContent = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-outside-content-"));

  await assert.rejects(
    buildProjectUninstallPlan({ ...project, contentPath: outsideContent }, { sourcePythonRoot }),
    /Refusing to uninstall unexpected path/
  );
});

test("project uninstall planner refuses package symlinks when the filesystem allows them", async (t) => {
  const project = await makeTempProject();
  const targetPackage = path.join(project.contentPath, "Python", "uefn_mcp_bridge");
  const sourcePackage = path.join(sourcePythonRoot, "uefn_mcp_bridge");
  try {
    await fs.symlink(sourcePackage, targetPackage, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlinks unavailable in this environment: ${error.code ?? error.message}`);
    return;
  }

  await assert.rejects(
    buildProjectUninstallPlan(project, { sourcePythonRoot }),
    /symlink|junction/
  );
});

test("project uninstall planner refuses modified launcher and unexpected package files", async () => {
  const modifiedLauncher = await makeTempProject();
  await installManagedPlugin(modifiedLauncher);
  await fs.writeFile(path.join(modifiedLauncher.contentPath, "Python", "start_uefn_mcp_bridge.py"), "print('custom')\n", "utf8");

  await assert.rejects(
    buildProjectUninstallPlan(modifiedLauncher, { sourcePythonRoot }),
    /launcher.*does not match/
  );

  const extraFile = await makeTempProject();
  await installManagedPlugin(extraFile);
  await fs.writeFile(path.join(extraFile.contentPath, "Python", "uefn_mcp_bridge", "notes.txt"), "user notes", "utf8");

  await assert.rejects(
    buildProjectUninstallPlan(extraFile, { sourcePythonRoot }),
    /unexpected file/
  );
});

test("managed init_unreal.py block removal preserves user code and deletes empty managed files", () => {
  const existing = [
    "print('before')",
    "",
    MANAGED_INIT_BLOCK,
    "",
    "print('after')",
    ""
  ].join("\n");
  const preserved = removeManagedInitBlockText(existing);

  assert.equal(preserved.changed, true);
  assert.equal(preserved.deleteFile, false);
  assert.match(preserved.next, /print\('before'\)/);
  assert.match(preserved.next, /print\('after'\)/);
  assert.doesNotMatch(preserved.next, /BEGIN UEFN_MCP_BRIDGE/);

  const empty = removeManagedInitBlockText(`${MANAGED_INIT_BLOCK}\n`);
  assert.equal(empty.changed, true);
  assert.equal(empty.deleteFile, true);
  assert.equal(empty.next, "");
});

test("dry-run planning reports removals without changing files", async () => {
  const project = await makeTempProject();
  await installManagedPlugin(project);
  const launcher = path.join(project.contentPath, "Python", "start_uefn_mcp_bridge.py");
  const packageDir = path.join(project.contentPath, "Python", "uefn_mcp_bridge");

  const plan = await buildProjectUninstallPlan(project, { sourcePythonRoot });

  assert.deepEqual(plan.actions.map((action) => action.action).sort(), [
    "remove_init_block",
    "remove_launcher",
    "remove_package"
  ].sort());
  await fs.access(launcher);
  await fs.access(packageDir);
  assert.match(await fs.readFile(path.join(project.contentPath, "Python", "init_unreal.py"), "utf8"), /BEGIN UEFN_MCP_BRIDGE/);
});

test("rollback restores Codex config and UEFN plugin files after simulated uninstall failure", async () => {
  const project = await makeTempProject();
  await installManagedPlugin(project);
  const editorSettings = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-settings-")), "EditorPerProjectUserSettings.ini");
  const launcher = path.join(project.contentPath, "Python", "start_uefn_mcp_bridge.py");
  await fs.writeFile(editorSettings, `[Python]\nRecentsFiles=${launcher.replaceAll("\\", "/")}\n`, "utf8");

  const codexConfig = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-codex-")), "config.toml");
  await fs.writeFile(codexConfig, `model = "gpt-5"\n\n${codexMcpBlock(repoRoot)}\n`, "utf8");

  const projectPlan = await buildProjectUninstallPlan(project, { sourcePythonRoot, editorUserSettings: editorSettings });
  const codexPlan = await planCodexUninstall(codexConfig, repoRoot);
  const rollback = new RollbackManager({ operation: "Uninstallation" });
  await rollback.prepare();

  let caught = null;
  try {
    await applyGuidedUninstallPlan({ projectPlan, codexPlan, localConfigPlan: null }, {
      rollback,
      failAfterActions: 5
    });
    rollback.commit();
  } catch (error) {
    caught = error;
    await rollback.rollback(error);
  }

  assert.match(caught?.message ?? "", /Simulated uninstall failure/);
  await fs.access(path.join(project.contentPath, "Python", "uefn_mcp_bridge"));
  await fs.access(launcher);
  assert.match(await fs.readFile(path.join(project.contentPath, "Python", "init_unreal.py"), "utf8"), /BEGIN UEFN_MCP_BRIDGE/);
  assert.match(await fs.readFile(editorSettings, "utf8"), /RecentsFiles=/);
  assert.match(await fs.readFile(codexConfig, "utf8"), /\[mcp_servers\."uefn-mcp"\]/);
});

async function makeTempProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "uefn-mcp-project-"));
  const contentPath = path.join(projectPath, "Content");
  const pythonPath = path.join(contentPath, "Python");
  await fs.mkdir(pythonPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, "Island.uefnproject"), JSON.stringify({
    title: "Island",
    plugins: [{ name: "Island", bIsRoot: true }]
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectPath, "Island.uplugin"), JSON.stringify({ VersePath: "/Island" }, null, 2), "utf8");
  return {
    projectPath,
    contentPath,
    uefnProjectPath: path.join(projectPath, "Island.uefnproject"),
    upluginPath: path.join(projectPath, "Island.uplugin")
  };
}

async function installManagedPlugin(project) {
  const pythonPath = path.join(project.contentPath, "Python");
  await fs.cp(path.join(sourcePythonRoot, "uefn_mcp_bridge"), path.join(pythonPath, "uefn_mcp_bridge"), {
    recursive: true,
    force: true
  });
  await fs.copyFile(path.join(sourcePythonRoot, "start_uefn_mcp_bridge.py"), path.join(pythonPath, "start_uefn_mcp_bridge.py"));
  await fs.writeFile(path.join(pythonPath, "init_unreal.py"), `${MANAGED_INIT_BLOCK}\n`, "utf8");
}
