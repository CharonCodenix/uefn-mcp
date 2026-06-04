#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BLOCK_START = "# BEGIN UEFN_MCP_BRIDGE";
const BLOCK_END = "# END UEFN_MCP_BRIDGE";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePythonRoot = path.join(repoRoot, "uefn-plugin", "Content", "Python");
const projectPathInput = args.project ?? process.env.UEFN_PROJECT_PATH;
if (!projectPathInput) {
  throw new Error("Missing target UEFN project. Pass --project \"C:\\Path\\To\\YourProject\" or set UEFN_PROJECT_PATH.");
}
const projectPath = path.resolve(projectPathInput);
const dryRun = args.dryRun === true;
const uninstall = args.uninstall === true;

const result = await run();
console.log(JSON.stringify(result, null, 2));

async function run() {
  const project = await inspectProject(projectPath);
  const targetPythonRoot = path.join(project.projectPath, "Content", "Python");
  const targetPackageDir = path.join(targetPythonRoot, "uefn_mcp_bridge");
  const targetLauncher = path.join(targetPythonRoot, "start_uefn_mcp_bridge.py");
  const targetInit = path.join(targetPythonRoot, "init_unreal.py");
  const editorUserSettings = getEditorUserSettingsPath();
  const actions = [];

  if (uninstall) {
    actions.push({ action: "remove_package", path: targetPackageDir });
    actions.push({ action: "remove_launcher", path: targetLauncher });
    actions.push({ action: "remove_init_block", path: targetInit });
    if (editorUserSettings) {
      actions.push({ action: "remove_python_recent_script", path: editorUserSettings, script: toUnrealPath(targetLauncher) });
    }
    if (!dryRun) {
      await fs.rm(targetPackageDir, { recursive: true, force: true });
      await fs.rm(targetLauncher, { force: true });
      await updateInitFile(targetInit, { uninstall: true });
      if (editorUserSettings) {
        await updatePythonRecentScripts(editorUserSettings, targetLauncher, { uninstall: true });
      }
    }
  } else {
    actions.push({ action: "copy_package", from: path.join(sourcePythonRoot, "uefn_mcp_bridge"), to: targetPackageDir });
    actions.push({ action: "copy_launcher", from: path.join(sourcePythonRoot, "start_uefn_mcp_bridge.py"), to: targetLauncher });
    actions.push({ action: "insert_init_block", path: targetInit });
    actions.push({ action: "enable_python_experimental", path: project.uefnProjectPath });
    if (editorUserSettings) {
      actions.push({ action: "add_python_recent_script", path: editorUserSettings, script: toUnrealPath(targetLauncher) });
    }
    if (!dryRun) {
      await fs.mkdir(targetPythonRoot, { recursive: true });
      await fs.cp(path.join(sourcePythonRoot, "uefn_mcp_bridge"), targetPackageDir, {
        recursive: true,
        force: true
      });
      await fs.copyFile(path.join(sourcePythonRoot, "start_uefn_mcp_bridge.py"), targetLauncher);
      await updateInitFile(targetInit, { uninstall: false });
      await enablePython(project.uefnProjectPath);
      if (editorUserSettings) {
        await updatePythonRecentScripts(editorUserSettings, targetLauncher, { uninstall: false });
      }
    }
  }

  return {
    ok: true,
    dryRun,
    uninstall,
    project: {
      path: project.projectPath,
      uefnProjectPath: project.uefnProjectPath,
      rootPluginPath: project.rootPluginPath
    },
    actions,
    codexConfigSnippet: codexSnippet(repoRoot),
    nextStep: uninstall
      ? "Restart UEFN to unload the launcher if it was already open."
      : "Restart UEFN, open the project, then click the UEFN MCP Bridge > Start Bridge launcher window."
  };
}

async function inspectProject(projectPathValue) {
  const stat = await fs.stat(projectPathValue);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPathValue}`);
  }
  const entries = await fs.readdir(projectPathValue);
  const projectFiles = entries.filter((name) => name.toLowerCase().endsWith(".uefnproject"));
  if (projectFiles.length !== 1) {
    throw new Error(`Expected exactly one .uefnproject in ${projectPathValue}, found ${projectFiles.length}.`);
  }
  const uefnProjectPath = path.join(projectPathValue, projectFiles[0]);
  const uefnProject = JSON.parse(await fs.readFile(uefnProjectPath, "utf8"));
  const rootPluginName = uefnProject.plugins?.find((plugin) => plugin.bIsRoot === true)?.name ?? path.basename(projectPathValue);
  const rootPluginPath = path.join(projectPathValue, `${rootPluginName}.uplugin`);
  await fs.access(rootPluginPath);
  return {
    projectPath: projectPathValue,
    uefnProjectPath,
    rootPluginPath
  };
}

async function updateInitFile(filePath, options) {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const withoutBlock = removeManagedBlock(existing).trimEnd();
  if (options.uninstall) {
    if (withoutBlock.length === 0) {
      await fs.rm(filePath, { force: true });
    } else {
      await fs.writeFile(filePath, `${withoutBlock}\n`, "utf8");
    }
    return;
  }

  const block = [
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
  const next = withoutBlock.length > 0 ? `${withoutBlock}\n\n${block}\n` : `${block}\n`;
  await fs.writeFile(filePath, next, "utf8");
}

async function enablePython(projectFilePath) {
  const project = JSON.parse(await fs.readFile(projectFilePath, "utf8"));
  project.dataSets ??= {};
  project.dataSets.experimental ??= {};
  project.dataSets.experimental.version ??= 1;
  project.dataSets.experimental.pythonExperimental ??= {};
  project.dataSets.experimental.pythonExperimental.bEnablePythonForProject = true;
  await fs.writeFile(projectFilePath, `${JSON.stringify(project, null, "\t")}\n`, "utf8");
}

async function updatePythonRecentScripts(filePath, launcherPath, options) {
  const launcher = toUnrealPath(launcherPath);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && options.uninstall) {
      return;
    }
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const nextLines = lines.filter((line) => {
    if (!line.startsWith("RecentsFiles=")) {
      return true;
    }
    return line.slice("RecentsFiles=".length).trim().toLowerCase() !== launcher.toLowerCase();
  });

  if (!options.uninstall) {
    let insertIndex = findSection(nextLines, "Python");
    if (insertIndex === -1) {
      if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
        nextLines.push("");
      }
      nextLines.push("[Python]");
      insertIndex = nextLines.length - 1;
    }
    nextLines.splice(insertIndex + 1, 0, `RecentsFiles=${launcher}`);
  } else if (existing.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${nextLines.join("\n").trimEnd()}\n`, "utf8");
}

function findSection(lines, sectionName) {
  const header = `[${sectionName}]`;
  return lines.findIndex((line) => line.trim() === header);
}

function getEditorUserSettingsPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  return path.join(localAppData, "UnrealEditorFortnite", "Saved", "Config", "WindowsEditor", "EditorPerProjectUserSettings.ini");
}

function toUnrealPath(value) {
  return value.replaceAll("\\", "/");
}

function removeManagedBlock(value) {
  const start = value.indexOf(BLOCK_START);
  const end = value.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return value;
  }
  return `${value.slice(0, start)}${value.slice(end + BLOCK_END.length)}`;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--project") {
      parsed.project = rawArgs[++index];
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--uninstall") {
      parsed.uninstall = true;
    } else if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/install_uefn_plugin.mjs [--project <UEFN project path>] [--dry-run] [--uninstall]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function codexSnippet(root) {
  const escapedRoot = root.replaceAll("\\", "\\\\");
  const serverPath = path.join(root, "src", "server.mjs").replaceAll("\\", "\\\\");
  return [
    '[mcp_servers."uefn-mcp"]',
    'command = "node"',
    `args = ["${serverPath}"]`,
    `cwd = "${escapedRoot}"`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    "enabled = true"
  ].join("\n");
}
