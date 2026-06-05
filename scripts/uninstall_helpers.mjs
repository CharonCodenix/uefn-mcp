import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isPathInside } from "../src/lib/project.mjs";

export const BLOCK_START = "# BEGIN UEFN_MCP_BRIDGE";
export const BLOCK_END = "# END UEFN_MCP_BRIDGE";
export const SERVER_NAME = "uefn-mcp";
export const MANAGED_INIT_BLOCK = [
  BLOCK_START,
  "try:",
  "    import uefn_mcp_bridge",
  "    uefn_mcp_bridge.register_menu()",
  "except Exception as exc:",
  "    try:",
  "        import unreal",
  "        unreal.log_error('UEFN MCP: failed to register menu: {}'.format(exc))",
  "    except Exception:",
  "        print('UEFN MCP: failed to register menu: {}'.format(exc))",
  BLOCK_END
].join("\n");

export async function buildProjectUninstallPlan(project, options = {}) {
  const projectPath = path.resolve(project.projectPath);
  const contentPath = path.resolve(project.contentPath ?? path.join(projectPath, "Content"));
  const targetPythonRoot = path.resolve(contentPath, "Python");
  const targetPackageDir = path.join(targetPythonRoot, "uefn_mcp_bridge");
  const targetLauncher = path.join(targetPythonRoot, "start_uefn_mcp_bridge.py");
  const targetInit = path.join(targetPythonRoot, "init_unreal.py");
  const sourcePythonRoot = path.resolve(options.sourcePythonRoot ?? path.join(path.resolve("."), "uefn-plugin", "Content", "Python"));
  const sourcePackageDir = path.join(sourcePythonRoot, "uefn_mcp_bridge");
  const sourceLauncher = path.join(sourcePythonRoot, "start_uefn_mcp_bridge.py");
  const editorUserSettings = options.editorUserSettings ?? getEditorUserSettingsPath();

  assertExactProjectTarget(projectPath, targetPackageDir, ["Content", "Python", "uefn_mcp_bridge"]);
  assertExactProjectTarget(projectPath, targetLauncher, ["Content", "Python", "start_uefn_mcp_bridge.py"]);
  assertExactProjectTarget(projectPath, targetInit, ["Content", "Python", "init_unreal.py"]);
  if (!isPathInside(path.resolve(projectPath, "Content"), targetPythonRoot)) {
    throw new Error(`Refusing to uninstall from a Python path outside this project Content folder: ${targetPythonRoot}`);
  }

  const actions = [];
  const skipped = [];

  const packageAction = await planManagedPackageRemoval(targetPackageDir, sourcePackageDir, targetPythonRoot);
  if (packageAction.action === "skip") {
    skipped.push(packageAction);
  } else {
    actions.push(packageAction);
  }

  const launcherAction = await planManagedLauncherRemoval(targetLauncher, sourceLauncher, targetPythonRoot);
  if (launcherAction.action === "skip") {
    skipped.push(launcherAction);
  } else {
    actions.push(launcherAction);
  }

  const initAction = await planManagedInitRemoval(targetInit, targetPythonRoot);
  if (initAction.action === "skip") {
    skipped.push(initAction);
  } else {
    actions.push(initAction);
  }

  if (editorUserSettings) {
    const recentAction = await planRecentScriptRemoval(editorUserSettings, targetLauncher);
    if (recentAction.action === "skip") {
      skipped.push(recentAction);
    } else {
      actions.push(recentAction);
    }
  }

  return {
    type: "project",
    projectPath,
    targetPythonRoot,
    targetPackageDir,
    targetLauncher,
    targetInit,
    editorUserSettings,
    actions,
    skipped
  };
}

export async function applyProjectUninstallPlan(plan, options = {}) {
  for (const action of plan.actions) {
    await applyProjectAction(action, options.rollback);
    await notifyApplied(action, options);
  }
}

export async function planCodexUninstall(configPath, repoRoot) {
  const resolvedConfigPath = path.resolve(configPath);
  let existing = "";
  try {
    existing = await fs.readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        type: "codex",
        configPath: resolvedConfigPath,
        actions: [],
        skipped: [{ action: "skip_codex_config", path: resolvedConfigPath, reason: "Codex config was not found." }]
      };
    }
    throw error;
  }

  const removal = removeCodexMcpBlockForRepo(existing, repoRoot);
  if (!removal.changed) {
    return {
      type: "codex",
      configPath: resolvedConfigPath,
      actions: [],
      skipped: [{
        action: removal.foundOtherRepoBlock ? "skip_codex_other_repo" : "skip_codex_config",
        path: resolvedConfigPath,
        reason: removal.reason
      }]
    };
  }

  return {
    type: "codex",
    configPath: resolvedConfigPath,
    actions: [{
      action: "remove_codex_mcp_block",
      path: resolvedConfigPath,
      next: removal.next,
      removedBlocks: removal.removedBlocks
    }],
    skipped: []
  };
}

export async function applyCodexUninstallPlan(plan, options = {}) {
  for (const action of plan.actions) {
    await options.rollback?.capture(action.path);
    await fs.writeFile(action.path, action.next, "utf8");
    await notifyApplied(action, options);
  }
}

export async function planLocalConfigUninstall(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  let existing = "";
  try {
    existing = await fs.readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        type: "local_config",
        configPath: resolvedConfigPath,
        actions: [],
        skipped: [{ action: "skip_local_config", path: resolvedConfigPath, reason: "Local config was not found." }]
      };
    }
    throw error;
  }

  if (!isGeneratedLocalConfig(existing)) {
    return {
      type: "local_config",
      configPath: resolvedConfigPath,
      actions: [],
      skipped: [{ action: "skip_local_config", path: resolvedConfigPath, reason: "Local config does not match the generated UEFN MCP config shape." }]
    };
  }

  return {
    type: "local_config",
    configPath: resolvedConfigPath,
    actions: [{ action: "remove_local_config", path: resolvedConfigPath }],
    skipped: []
  };
}

export async function applyLocalConfigUninstallPlan(plan, options = {}) {
  for (const action of plan.actions) {
    await options.rollback?.capture(action.path);
    await fs.rm(action.path, { force: true });
    await notifyApplied(action, options);
  }
}

export async function applyGuidedUninstallPlan(plan, options = {}) {
  await applyProjectUninstallPlan(plan.projectPlan, options);
  await applyCodexUninstallPlan(plan.codexPlan, options);
  if (plan.localConfigPlan) {
    await applyLocalConfigUninstallPlan(plan.localConfigPlan, options);
  }
}

export function removeCodexMcpBlockForRepo(existing, repoRoot) {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const removeRanges = [];
  let foundOtherRepoBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (!isCodexServerHeader(lines[index])) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !isTomlHeader(lines[end])) {
      end += 1;
    }
    const block = lines.slice(index, end).join("\n");
    if (codexBlockTargetsRepo(block, repoRoot)) {
      removeRanges.push({ start: index, end });
    } else {
      foundOtherRepoBlock = true;
    }
    index = end - 1;
  }

  if (removeRanges.length === 0) {
    return {
      changed: false,
      next: existing,
      removedBlocks: 0,
      foundOtherRepoBlock,
      reason: foundOtherRepoBlock
        ? "Found a uefn-mcp Codex block, but it points to another clone. It was left untouched."
        : "No uefn-mcp Codex block was found for this clone."
    };
  }

  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const range = removeRanges.find((candidate) => candidate.start === index);
    if (range) {
      index = range.end - 1;
      continue;
    }
    result.push(lines[index]);
  }

  const next = compactBlankLines(result.join(newline)).trimEnd();
  return {
    changed: true,
    next: next.length > 0 ? `${next}${newline}` : "",
    removedBlocks: removeRanges.length,
    foundOtherRepoBlock,
    reason: `Removed ${removeRanges.length} Codex uefn-mcp block(s) for this clone.`
  };
}

export function removeManagedInitBlockText(existing) {
  const starts = countOccurrences(existing, BLOCK_START);
  const ends = countOccurrences(existing, BLOCK_END);
  if (starts !== ends) {
    throw new Error("Refusing to edit init_unreal.py because the managed UEFN MCP block markers are unbalanced.");
  }
  if (starts === 0) {
    return { changed: false, deleteFile: false, next: existing };
  }

  let next = existing;
  while (true) {
    const start = next.indexOf(BLOCK_START);
    if (start === -1) {
      break;
    }
    const end = next.indexOf(BLOCK_END, start + BLOCK_START.length);
    if (end === -1 || end < start) {
      throw new Error("Refusing to edit init_unreal.py because the managed UEFN MCP block is malformed.");
    }
    next = `${next.slice(0, start)}${next.slice(end + BLOCK_END.length)}`;
  }

  const trimmed = next.trimEnd();
  return {
    changed: true,
    deleteFile: trimmed.length === 0,
    next: trimmed.length > 0 ? `${trimmed}\n` : ""
  };
}

export function removeRecentScriptText(existing, launcherPath) {
  const launcher = toUnrealPath(launcherPath).toLowerCase();
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const nextLines = lines.filter((line) => {
    if (!line.startsWith("RecentsFiles=")) {
      return true;
    }
    return line.slice("RecentsFiles=".length).trim().toLowerCase() !== launcher;
  });
  const changed = nextLines.length !== lines.length;
  return {
    changed,
    next: changed ? `${nextLines.join("\n").trimEnd()}\n` : existing
  };
}

export function isGeneratedLocalConfig(existing) {
  let config;
  try {
    config = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!config || typeof config !== "object") {
    return false;
  }
  if (typeof config.uefnProjectPath !== "string" || typeof config.contentPath !== "string") {
    return false;
  }
  const expectedContentPath = path.join(path.resolve(config.uefnProjectPath), "Content");
  return path.resolve(config.contentPath) === expectedContentPath
    && config.bridgeUrl === "http://127.0.0.1:8765"
    && config.verseWorkflowHost === "127.0.0.1"
    && config.verseWorkflowPort === 1962
    && config.bridgeBootstrapPort === 8766
    && config.resourceCacheDir === ".uefn-mcp-cache"
    && config.allowProjectPathOverride === false
    && config.allowExternalLogPath === false;
}

export function getEditorUserSettingsPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  return path.join(localAppData, "UnrealEditorFortnite", "Saved", "Config", "WindowsEditor", "EditorPerProjectUserSettings.ini");
}

export function toUnrealPath(value) {
  return String(value).replaceAll("\\", "/");
}

async function planManagedPackageRemoval(targetPackageDir, sourcePackageDir, targetPythonRoot) {
  if (!(await pathExists(targetPackageDir))) {
    return { action: "skip", target: "package", path: targetPackageDir, reason: "Managed package folder was not found." };
  }
  assertInside(targetPythonRoot, targetPackageDir, "managed package");
  const lstat = await fs.lstat(targetPackageDir);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to remove managed package because it is a symlink or junction: ${targetPackageDir}`);
  }
  const stat = await fs.stat(targetPackageDir);
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to remove managed package because it is not a directory: ${targetPackageDir}`);
  }

  const sourceTree = await listTree(sourcePackageDir);
  const targetTree = await listTree(targetPackageDir);
  const initPath = path.join(targetPackageDir, "__init__.py");
  const initText = await readTextRequired(initPath, "managed package marker");
  assertPackageMarkers(initText, initPath);

  for (const dir of targetTree.dirs) {
    if (dir === "" || sourceTree.dirs.has(dir) || isCachePath(dir)) {
      continue;
    }
    throw new Error(`Refusing to remove managed package because it contains an unexpected directory: ${path.join(targetPackageDir, dir)}`);
  }
  for (const file of targetTree.files) {
    if (sourceTree.files.has(file) || isCacheFile(file)) {
      continue;
    }
    throw new Error(`Refusing to remove managed package because it contains an unexpected file: ${path.join(targetPackageDir, file)}`);
  }

  return {
    action: "remove_package",
    path: targetPackageDir,
    files: targetTree.files.size,
    cacheArtifacts: [...targetTree.files].filter(isCacheFile).length
  };
}

async function planManagedLauncherRemoval(targetLauncher, sourceLauncher, targetPythonRoot) {
  if (!(await pathExists(targetLauncher))) {
    return { action: "skip", target: "launcher", path: targetLauncher, reason: "Managed launcher script was not found." };
  }
  assertInside(targetPythonRoot, targetLauncher, "managed launcher");
  const lstat = await fs.lstat(targetLauncher);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to remove launcher because it is a symlink: ${targetLauncher}`);
  }
  const stat = await fs.stat(targetLauncher);
  if (!stat.isFile()) {
    throw new Error(`Refusing to remove launcher because it is not a file: ${targetLauncher}`);
  }
  const targetText = await fs.readFile(targetLauncher, "utf8");
  const sourceText = await fs.readFile(sourceLauncher, "utf8");
  if (normalizeManagedText(targetText) !== normalizeManagedText(sourceText)) {
    throw new Error(`Refusing to remove launcher because its content does not match the managed launcher: ${targetLauncher}`);
  }
  return { action: "remove_launcher", path: targetLauncher };
}

async function planManagedInitRemoval(targetInit, targetPythonRoot) {
  if (!(await pathExists(targetInit))) {
    return { action: "skip", target: "init_unreal", path: targetInit, reason: "init_unreal.py was not found." };
  }
  assertInside(targetPythonRoot, targetInit, "managed init block");
  const lstat = await fs.lstat(targetInit);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to edit init_unreal.py because it is a symlink: ${targetInit}`);
  }
  const existing = await fs.readFile(targetInit, "utf8");
  const removal = removeManagedInitBlockText(existing);
  if (!removal.changed) {
    return { action: "skip", target: "init_unreal", path: targetInit, reason: "No managed init_unreal.py block was found." };
  }
  return {
    action: "remove_init_block",
    path: targetInit,
    next: removal.next,
    deleteFile: removal.deleteFile
  };
}

async function planRecentScriptRemoval(editorUserSettings, targetLauncher) {
  if (!(await pathExists(editorUserSettings))) {
    return { action: "skip", target: "recent_script", path: editorUserSettings, reason: "UEFN editor user settings were not found." };
  }
  const existing = await fs.readFile(editorUserSettings, "utf8");
  const removal = removeRecentScriptText(existing, targetLauncher);
  if (!removal.changed) {
    return { action: "skip", target: "recent_script", path: editorUserSettings, reason: "Matching recent-script entry was not found." };
  }
  return {
    action: "remove_python_recent_script",
    path: editorUserSettings,
    script: toUnrealPath(targetLauncher),
    next: removal.next
  };
}

async function applyProjectAction(action, rollback) {
  if (action.action === "remove_package") {
    await rollback?.capture(action.path);
    await fs.rm(action.path, { recursive: true, force: true });
    return;
  }
  if (action.action === "remove_launcher") {
    await rollback?.capture(action.path);
    await fs.rm(action.path, { force: true });
    return;
  }
  if (action.action === "remove_init_block") {
    await rollback?.capture(action.path);
    if (action.deleteFile) {
      await fs.rm(action.path, { force: true });
    } else {
      await fs.writeFile(action.path, action.next, "utf8");
    }
    return;
  }
  if (action.action === "remove_python_recent_script") {
    await rollback?.capture(action.path);
    await fs.writeFile(action.path, action.next, "utf8");
    return;
  }
  throw new Error(`Unknown uninstall action: ${action.action}`);
}

async function notifyApplied(action, options) {
  if (typeof options.onActionApplied === "function") {
    await options.onActionApplied(action);
  }
  if (Number.isInteger(options.failAfterActions)) {
    options.appliedActionCount = (options.appliedActionCount ?? 0) + 1;
    if (options.appliedActionCount === options.failAfterActions) {
      throw new Error("Simulated uninstall failure after applying action.");
    }
  }
}

function codexBlockTargetsRepo(block, repoRoot) {
  const cwd = readTomlStringAssignment(block, "cwd");
  const args = readTomlArrayStrings(block, "args");
  const resolvedRoot = path.resolve(repoRoot);
  const serverPath = path.join(resolvedRoot, "src", "server.mjs");
  return (cwd && samePath(cwd, resolvedRoot)) || args.some((arg) => samePath(arg, serverPath));
}

function readTomlStringAssignment(block, key) {
  const match = block.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "m"));
  return match ? unescapeTomlBasicString(match[1]) : null;
}

function readTomlArrayStrings(block, key) {
  const match = block.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[(.*)\\]`, "m"));
  if (!match) {
    return [];
  }
  const result = [];
  const quoted = /"((?:\\.|[^"\\])*)"/g;
  for (const item of match[1].matchAll(quoted)) {
    result.push(unescapeTomlBasicString(item[1]));
  }
  return result;
}

function unescapeTomlBasicString(value) {
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t");
}

function isCodexServerHeader(line) {
  const trimmed = line.trim();
  return trimmed === '[mcp_servers."uefn-mcp"]' || trimmed === "[mcp_servers.uefn-mcp]";
}

function isTomlHeader(line) {
  return /^\s*\[{1,2}[^\]]+\]{1,2}\s*$/.test(line);
}

function compactBlankLines(value) {
  return value.replace(/\n{3,}/g, "\n\n").replace(/\r\n{3,}/g, "\r\n\r\n");
}

async function listTree(root) {
  const files = new Set();
  const dirs = new Set([""]);

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = normalizeRelative(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        dirs.add(relative);
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.add(relative);
      } else {
        throw new Error(`Refusing to remove managed package because it contains an unsupported filesystem entry: ${fullPath}`);
      }
    }
  }

  await walk(root);
  return { files, dirs };
}

function assertPackageMarkers(value, filePath) {
  const markers = [
    'RUNTIME_STATE_KEY = "_uefn_mcp_bridge_runtime_state"',
    "def register_menu",
    "def start_bridge_from_menu",
    '"service": "uefn_mcp_bridge"'
  ];
  for (const marker of markers) {
    if (!value.includes(marker)) {
      throw new Error(`Refusing to remove managed package because ${filePath} is missing marker: ${marker}`);
    }
  }
}

async function readTextRequired(filePath, label) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Refusing to remove ${label} because the expected file is missing: ${filePath}`);
    }
    throw error;
  }
}

function assertExactProjectTarget(projectPath, targetPath, expectedRelativeParts) {
  const expected = path.resolve(projectPath, ...expectedRelativeParts);
  if (!samePath(targetPath, expected)) {
    throw new Error(`Refusing to uninstall unexpected path. Expected ${expected}, received ${targetPath}`);
  }
}

function assertInside(root, candidate, label) {
  if (!isPathInside(path.resolve(root), path.resolve(candidate))) {
    throw new Error(`Refusing to touch ${label} outside the expected folder: ${candidate}`);
  }
}

function samePath(left, right) {
  const normalizedLeft = normalizeComparePath(path.resolve(left));
  const normalizedRight = normalizeComparePath(path.resolve(right));
  return normalizedLeft === normalizedRight;
}

function normalizeComparePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function normalizeManagedText(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function isCachePath(relativePath) {
  return normalizeRelative(relativePath).split("/").includes("__pycache__");
}

function isCacheFile(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return normalized.endsWith(".pyc") || normalized.endsWith(".pyo");
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
