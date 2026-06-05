#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { inspectUefnProjectPath, isPathInside } from "../src/lib/project.mjs";

const BLOCK_START = "# BEGIN UEFN_MCP_BRIDGE";
const BLOCK_END = "# END UEFN_MCP_BRIDGE";
const SERVER_NAME = "uefn-mcp";
const PNPM_COMMAND = "pnpm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePythonRoot = path.join(repoRoot, "uefn-plugin", "Content", "Python");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const rollback = new RollbackManager({ disabled: args.noRollback === true });

  try {
    await showIntro();
    step("Welcome", "This installer will explain each change it makes.");
    const project = await chooseProject(rl, args.project ?? process.cwd());
    const clients = await chooseClients(rl, args.clients);

    await validateRuntime(rl, { assumeYes: args.yes });
    await installDependencies();
    await rollback.prepare();
    await writeLocalConfig(project.projectPath, rollback);
    const pluginResult = await installPluginGuided(project, rl, { assumeYes: args.yes, rollback });
    const configuredClients = await configureClients(clients, project.projectPath, rollback);

    const smokeResult = await runCommand(PNPM_COMMAND, ["mcp:smoke"], {
      cwd: repoRoot,
      label: "MCP smoke test"
    });
    rollback.commit();

    let bridgeCheck = null;
    if (await askYesNo(rl, "Do you want to run a real UEFN status test now? This requires UEFN open and Start Bridge clicked. (Y/N)", false)) {
      bridgeCheck = await runUefnStatusTest(project.projectPath);
    }

    printSummary({
      project,
      clients,
      configuredClients,
      pluginResult,
      smokeResult,
      bridgeCheck
    });
  } catch (error) {
    if (!rollback.committed && rollback.hasChanges()) {
      await rollback.rollback(error);
    }
    throw error;
  } finally {
    rl.close();
  }
}

async function showIntro() {
  const banner = buildIntroBanner();
  const cells = [];
  for (let row = 0; row < banner.length; row += 1) {
    for (let col = 0; col < banner[row].length; col += 1) {
      if (banner[row][col] !== " ") {
        cells.push({ row, col, char: banner[row][col], order: col * 1.8 + row * 0.35 });
      }
    }
  }
  cells.sort((left, right) => left.order - right.order);

  const frameCount = 40;
  const frameDelayMs = 50;
  const width = Math.max(...banner.map((line) => line.length));
  const blank = banner.map(() => Array.from(" ".repeat(width)));
  console.log("");
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const visible = Math.ceil((cells.length * frame) / frameCount);
    const canvas = blank.map((line) => [...line]);
    for (const cell of cells.slice(0, visible)) {
      canvas[cell.row][cell.col] = cell.char;
    }
    if (frame > 1) {
      process.stdout.write(`\x1b[${banner.length}A`);
    }
    process.stdout.write(canvas.map((line) => line.join("").trimEnd()).join("\n"));
    process.stdout.write("\n");
    await delay(frameDelayMs);
  }
  console.log("");
  console.log("");
}

export function buildIntroBanner() {
  return [
    "  +--------------------------------------------------------------------+",
    "  | ##   ## ######  ####### ##   ##      ##   ##  ######  ######      |",
    "  | ##   ## ##      ##      ###  ##      ### ### ##    ## ##   ##     |",
    "  | ##   ## ##      ##      #### ##      ####### ##       ##   ##     |",
    "  | ##   ## #####   #####   ## ####      ## # ## ##       ######      |",
    "  | ##   ## ##      ##      ##  ###      ##   ## ##       ##          |",
    "  | ##   ## ##      ##      ##   ##      ##   ## ##    ## ##          |",
    "  |  #####  ######  ##      ##   ##      ##   ##  ######  ##          |",
    "  +--------------------------------------------------------------------+"
  ];
}

async function chooseProject(rl, initialPath) {
  let inspection = await inspectCandidate(initialPath);
  if (inspection.safeToAnalyze) {
    printProjectInspection(inspection);
    return inspection;
  }

  warnInvalidProject(initialPath, inspection);
  const manual = await askYesNo(rl, "This folder is not a valid UEFN project root. Enter a project path manually? (Y/N)", true);
  if (!manual) {
    throw new Error("Please rerun this installer from the UEFN project root.");
  }

  while (true) {
    const answer = (await rl.question("UEFN project path: ")).trim().replace(/^"|"$/g, "");
    if (!answer) {
      console.log("Please enter a path.");
      continue;
    }
    inspection = await inspectCandidate(answer);
    if (inspection.safeToAnalyze) {
      printProjectInspection(inspection);
      return inspection;
    }
    warnInvalidProject(answer, inspection);
    if (!(await askYesNo(rl, "Try another path? (Y/N)", true))) {
      throw new Error("Please rerun this installer from the UEFN project root.");
    }
  }
}

async function inspectCandidate(candidate) {
  return inspectUefnProjectPath(path.resolve(candidate));
}

function printProjectInspection(inspection) {
  step("Project detected", inspection.projectPath);
  for (const signal of inspection.signals) {
    console.log(`  [ok] ${signal}`);
  }
  for (const warning of inspection.warnings) {
    console.log(`  [warn] ${warning}`);
  }
}

function warnInvalidProject(candidate, inspection) {
  step("Project validation failed", path.resolve(candidate));
  for (const error of inspection.errors) {
    console.log(`  [missing] ${error}`);
  }
  for (const warning of inspection.warnings) {
    console.log(`  [warn] ${warning}`);
  }
  console.log("  Required signals: exactly one .uefnproject, a readable root .uplugin, and Content/.");
  console.log("  Optional signal: .urc, used by Unreal Revision Control.");
}

async function chooseClients(rl, forced) {
  if (forced) {
    const normalized = forced.toLowerCase();
    if (["codex", "claude", "both"].includes(normalized)) {
      return normalized;
    }
    throw new Error("--clients must be codex, claude, or both.");
  }

  console.log("");
  console.log("Where should the MCP be installed?");
  console.log("  1) Codex only");
  console.log("  2) Claude Code only");
  console.log("  3) Both");
  while (true) {
    const answer = (await rl.question("Choose 1, 2, or 3 [3]: ")).trim() || "3";
    if (answer === "1") {
      return "codex";
    }
    if (answer === "2") {
      return "claude";
    }
    if (answer === "3") {
      return "both";
    }
    console.log("Please choose 1, 2, or 3.");
  }
}

async function validateRuntime(rl, options = {}) {
  step("Runtime check", "Checking Node.js and pnpm.");
  const nodeStatus = nodeRuntimeStatus(process.version);
  if (!nodeStatus.ok) {
    throw new Error(nodeStatus.message);
  }
  console.log(`  [ok] Node.js ${process.version}`);
  await ensurePnpm(rl, options);
}

async function ensurePnpm(rl, options = {}) {
  await ensurePnpmWithIO({
    assumeYes: options.assumeYes === true,
    ask: (question, defaultYes) => askYesNo(rl, question, defaultYes),
    commandCanRun,
    runCommand: (command, args, commandOptions) => runCommand(command, args, {
      cwd: repoRoot,
      ...commandOptions
    }),
    log: (message) => console.log(message)
  });
}

export function nodeRuntimeStatus(version) {
  const normalized = String(version).replace(/^v/, "");
  const nodeMajor = Number.parseInt(normalized.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    return {
      ok: false,
      message: `Node.js 20 or newer is required. Current version: ${version}`
    };
  }
  return { ok: true, message: `Node.js ${version} is supported.` };
}

export async function ensurePnpmWithIO(io) {
  if (await io.commandCanRun(PNPM_COMMAND, ["--version"])) {
    io.log("  [ok] pnpm");
    return { ok: true, method: "already_available" };
  }

  io.log("  [missing] pnpm was not found on PATH.");
  io.log("  pnpm installs the local Node dependencies required by the MCP server.");
  const install = io.assumeYes || await io.ask("Install pnpm now? (Y/N)", true);
  if (!install) {
    throw new Error("pnpm is required. Install pnpm, then rerun this installer.");
  }

  if (await io.commandCanRun("corepack", ["--version"])) {
    io.log("  [info] Trying Corepack first.");
    const enabled = await io.runCommand("corepack", ["enable"], {
      label: "corepack enable",
      allowFailure: true
    });
    const prepared = enabled.exitCode === 0
      ? await io.runCommand("corepack", ["prepare", "pnpm@11.1.3", "--activate"], {
        label: "corepack prepare pnpm",
        allowFailure: true
      })
      : { exitCode: 1 };
    if (prepared.exitCode === 0 && await io.commandCanRun(PNPM_COMMAND, ["--version"])) {
      io.log("  [ok] pnpm installed with Corepack.");
      return { ok: true, method: "corepack" };
    }
    io.log("  [warn] Corepack did not make pnpm available.");
  } else {
    io.log("  [info] Corepack was not found.");
  }

  const npmFallback = io.assumeYes || await io.ask("Install pnpm globally with npm instead? (Y/N)", true);
  if (!npmFallback) {
    throw new Error("pnpm is required. Install pnpm, then rerun this installer.");
  }
  await io.runCommand("npm", ["install", "-g", "pnpm"], {
    label: "npm install -g pnpm"
  });
  if (!(await io.commandCanRun(PNPM_COMMAND, ["--version"]))) {
    throw new Error("pnpm was installed but is still not available on PATH. Restart the terminal and rerun this installer.");
  }
  io.log("  [ok] pnpm installed with npm.");
  return { ok: true, method: "npm" };
}

async function installDependencies() {
  step("Dependencies", "Running pnpm install so the MCP SDK is available.");
  await runCommand(PNPM_COMMAND, ["install"], {
    cwd: repoRoot,
    label: "pnpm install"
  });
  if (await canImportMcpSdk()) {
    console.log("  [ok] MCP SDK resolved from node_modules.");
    return;
  }

  console.log("  [warn] pnpm finished, but the MCP SDK could not be resolved.");
  console.log("  [info] This usually happens after copying a pnpm node_modules folder. Repairing dependencies now.");
  await runCommand(PNPM_COMMAND, ["install", "--force"], {
    cwd: repoRoot,
    label: "pnpm install --force"
  });
  if (await canImportMcpSdk()) {
    console.log("  [ok] MCP SDK resolved after dependency repair.");
    return;
  }

  console.log("  [warn] pnpm --force did not rebuild the node_modules links.");
  console.log("  [info] Removing only this clone's node_modules folder and reinstalling cleanly.");
  await removeNodeModulesForRepair();
  await runCommand(PNPM_COMMAND, ["install"], {
    cwd: repoRoot,
    label: "clean pnpm install"
  });
  if (!(await canImportMcpSdk())) {
    throw new Error("Dependencies are still incomplete after a clean pnpm install. Check pnpm output and disk permissions.");
  }
  console.log("  [ok] MCP SDK resolved after clean dependency repair.");
}

async function canImportMcpSdk() {
  const result = await runCommand("node", ["-e", "import('@modelcontextprotocol/sdk/server/mcp.js')"], {
    cwd: repoRoot,
    quiet: true
  });
  return result.exitCode === 0;
}

async function removeNodeModulesForRepair() {
  const nodeModulesPath = path.resolve(repoRoot, "node_modules");
  const relative = path.relative(repoRoot, nodeModulesPath);
  if (relative !== "node_modules") {
    throw new Error(`Refusing to remove unexpected dependency path: ${nodeModulesPath}`);
  }
  await fs.rm(nodeModulesPath, { recursive: true, force: true });
}

async function writeLocalConfig(projectPath, rollback) {
  step("Local MCP config", "Writing uefn-mcp.config.json for this clone.");
  const config = buildLocalConfig(projectPath);
  const configPath = path.join(repoRoot, "uefn-mcp.config.json");
  await rollback.capture(configPath);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`  [ok] ${configPath}`);
}

export function buildLocalConfig(projectPath) {
  const resolvedProject = path.resolve(projectPath);
  return {
    uefnProjectPath: resolvedProject,
    contentPath: path.join(resolvedProject, "Content"),
    bridgeUrl: "http://127.0.0.1:8765",
    verseWorkflowHost: "127.0.0.1",
    verseWorkflowPort: 1962,
    bridgeBootstrapPort: 8766,
    uefnLogPath: process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "UnrealEditorFortnite", "Saved", "Logs", "UnrealEditorFortnite.log")
      : "",
    resourceCacheDir: ".uefn-mcp-cache",
    allowProjectPathOverride: false,
    allowExternalLogPath: false
  };
}

async function installPluginGuided(project, rl, options = {}) {
  const rollback = options.rollback ?? new RollbackManager({ disabled: true });
  const targetPythonRoot = path.join(project.projectPath, "Content", "Python");
  const targetPackageDir = path.join(targetPythonRoot, "uefn_mcp_bridge");
  const targetLauncher = path.join(targetPythonRoot, "start_uefn_mcp_bridge.py");
  const targetInit = path.join(targetPythonRoot, "init_unreal.py");
  const collisions = await detectPluginCollisions(targetPackageDir, targetLauncher);
  await assertSafeInstallTargets(project, {
    targetPythonRoot,
    targetPackageDir,
    targetLauncher,
    targetInit
  });

  if (collisions.length > 0) {
    step("Existing installation detected", "The installer found files it manages.");
    for (const collision of collisions) {
      console.log(`  [found] ${collision}`);
    }
    const overwrite = options.assumeYes || await askYesNo(rl, "Repair/reinstall these managed UEFN MCP files? (Y/N)", true);
    if (!overwrite) {
      throw new Error("Installation stopped before changing existing UEFN MCP files.");
    }
  }

  step("UEFN plugin", "Copying the bridge and updating only the managed init_unreal.py block.");
  await rollback.capture(targetPackageDir);
  await rollback.capture(targetLauncher);
  await rollback.capture(targetInit);
  await rollback.capture(project.uefnProjectPath);
  await fs.mkdir(targetPythonRoot, { recursive: true });
  await fs.cp(path.join(sourcePythonRoot, "uefn_mcp_bridge"), targetPackageDir, {
    recursive: true,
    force: true
  });
  await fs.copyFile(path.join(sourcePythonRoot, "start_uefn_mcp_bridge.py"), targetLauncher);
  await updateInitFile(targetInit, { uninstall: false });
  await enablePython(project.uefnProjectPath);

  const editorUserSettings = getEditorUserSettingsPath();
  if (editorUserSettings) {
    await rollback.capture(editorUserSettings);
    await updatePythonRecentScripts(editorUserSettings, targetLauncher, { uninstall: false });
  }

  console.log("  [ok] Python bridge copied.");
  console.log("  [ok] init_unreal.py managed block is installed once.");
  console.log("  [ok] UEFN Python is enabled for this project.");
  return { targetPythonRoot, targetPackageDir, targetLauncher, editorUserSettings };
}

export async function detectPluginCollisions(targetPackageDir, targetLauncher) {
  const collisions = [];
  if (await pathExists(targetPackageDir)) {
    collisions.push(targetPackageDir);
  }
  if (await pathExists(targetLauncher)) {
    collisions.push(targetLauncher);
  }
  return collisions;
}

export async function assertSafeInstallTargets(project, targets) {
  const projectPath = path.resolve(project.projectPath);
  const contentPath = path.resolve(project.contentPath ?? path.join(projectPath, "Content"));
  const realProjectPath = await fs.realpath(projectPath);
  await assertExistingPathInsideRealRoot(realProjectPath, contentPath, "project Content directory");

  for (const [label, targetPath] of Object.entries(targets)) {
    await assertInstallTargetInsideRealRoot(realProjectPath, targetPath, label);
  }
}

async function configureClients(selection, projectPath, rollback) {
  const configured = [];
  if (selection === "codex" || selection === "both") {
    configured.push(await configureCodex(rollback));
  }
  if (selection === "claude" || selection === "both") {
    configured.push(await configureClaude(projectPath, rollback));
  }
  return configured;
}

async function configureCodex(rollback) {
  step("Codex config", "Updating only the uefn-mcp MCP block in your user config.");
  const configPath = path.join(homeDir(), ".codex", "config.toml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await rollback.capture(configPath);
  const existing = await readTextIfExists(configPath);
  const next = upsertCodexMcpBlock(existing, repoRoot);
  await fs.writeFile(configPath, next, "utf8");
  console.log(`  [ok] ${configPath}`);
  return { client: "Codex", configPath };
}

export function upsertCodexMcpBlock(existing, root) {
  const block = codexMcpBlock(root);
  const without = removeTomlTable(existing, [
    '[mcp_servers."uefn-mcp"]',
    "[mcp_servers.uefn-mcp]"
  ]).trimEnd();
  return without.length > 0 ? `${without}\n\n${block}\n` : `${block}\n`;
}

export function codexMcpBlock(root) {
  const escapedRoot = escapeTomlString(path.resolve(root));
  const serverPath = escapeTomlString(path.join(path.resolve(root), "src", "server.mjs"));
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

export function removeTomlTable(existing, tableHeaders) {
  const lines = existing.split(/\r?\n/);
  const normalizedHeaders = new Set(tableHeaders.map((header) => header.trim()));
  const result = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = isTomlHeader(trimmed);
    if (isHeader && normalizedHeaders.has(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && isHeader) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  return result.join("\n");
}

function isTomlHeader(value) {
  return /^\[{1,2}[^\]]+\]{1,2}$/.test(value);
}

async function configureClaude(projectPath, rollback) {
  step("Claude Code config", "Adding a user-scoped stdio MCP server when the claude CLI is available.");
  const claudeConfig = claudeMcpJson(repoRoot, projectPath);
  const claudeJsonPath = path.join(homeDir(), ".claude.json");
  const claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  const exists = await commandCanRun(claudeCommand, ["--version"]);
  if (!exists) {
    console.log("  [warn] Claude Code CLI was not found on PATH.");
    console.log("  Manual JSON for Claude Code:");
    console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: claudeConfig } }, null, 2));
    return { client: "Claude Code", configPath: "~/.claude.json", manual: true };
  }

  await rollback.capture(claudeJsonPath);
  await runCommand(claudeCommand, ["mcp", "add-json", SERVER_NAME, JSON.stringify(claudeConfig), "--scope", "user"], {
    cwd: repoRoot,
    label: "claude mcp add-json"
  });
  console.log("  [ok] Claude Code user-scoped MCP server added.");
  return { client: "Claude Code", configPath: "~/.claude.json", manual: false };
}

export function claudeMcpJson(root, projectPath) {
  const resolvedProject = path.resolve(projectPath);
  return {
    type: "stdio",
    command: "node",
    args: [path.join(path.resolve(root), "src", "server.mjs")],
    env: {
      UEFN_PROJECT_PATH: resolvedProject,
      UEFN_CONTENT_PATH: path.join(resolvedProject, "Content"),
      UEFN_LOG_PATH: process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "UnrealEditorFortnite", "Saved", "Logs", "UnrealEditorFortnite.log")
        : ""
    }
  };
}

export async function runUefnStatusTest(projectPath) {
  step("UEFN status test", "Checking the real UEFN bridge on 127.0.0.1:8765, then calling uefn_status through MCP.");
  const bridgeUrl = "http://127.0.0.1:8765";
  const health = await checkHttpJson(`${bridgeUrl}/health`);
  if (!health?.ok) {
    console.log("  [not ready] The UEFN bridge is not responding on 127.0.0.1:8765.");
    console.log("  Open or restart the project in UEFN, click UEFN MCP Bridge > Start Bridge, then rerun this installer or ask your agent to call uefn_status.");
    return {
      ok: false,
      bridgeUrl,
      status: "bridge_not_ready",
      nextStep: "Open UEFN, click UEFN MCP Bridge > Start Bridge, then retry uefn_status."
    };
  }

  console.log(`  [ok] Bridge health responded: ${health.service ?? "unknown service"} ${health.version ?? ""}`.trimEnd());
  const statusArgs = projectPath ? { detailLevel: "detail", projectPath } : { detailLevel: "detail" };
  const status = await callMcpTool("uefn_status", statusArgs, 15000);
  if (status.error) {
    console.log(`  [failed] uefn_status returned an MCP error: ${JSON.stringify(status.error)}`);
    return {
      ok: false,
      bridgeUrl,
      status: "mcp_status_error",
      error: status.error
    };
  }

  const parsed = parseMcpJsonContent(status.result);
  const statusOk = parsed?.ok === true;
  console.log(`  [${statusOk ? "ok" : "warn"}] uefn_status returned ok=${String(parsed?.ok ?? "unknown")}.`);
  if (parsed?.project?.name) {
    console.log(`  [ok] Project: ${parsed.project.name}`);
  } else if (parsed?.project?.error) {
    console.log(`  [warn] Project validation: ${parsed.project.error}`);
  }
  if (parsed?.bridge?.ok) {
    console.log(`  [ok] Bridge: ${parsed.bridge.bridgeUrl}`);
  }
  if (parsed?.verseWorkflow?.ok) {
    console.log(`  [ok] Verse Workflow: ${parsed.verseWorkflow.host}:${parsed.verseWorkflow.port}`);
  }
  return {
    ok: statusOk,
    bridgeUrl,
    status: "uefn_status_called",
    result: parsed
  };
}

async function checkHttpJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  }
}

function printSummary(details) {
  step("Installation complete", "UEFN MCP is ready for the next restart/reload step.");
  console.log(`  Project: ${details.project.projectPath}`);
  console.log(`  Clients: ${details.clients === "both" ? "Codex and Claude Code" : details.clients}`);
  for (const item of details.configuredClients) {
    console.log(`  ${item.client}: ${item.manual ? "manual config printed" : item.configPath}`);
  }
  console.log(`  MCP smoke test: ${details.smokeResult.exitCode === 0 ? "passed" : "failed"}`);
  if (details.bridgeCheck) {
    console.log(`  UEFN status test: ${details.bridgeCheck.ok ? "passed" : "not ready"}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Open or restart this UEFN project.");
  console.log("  2. In UEFN, click UEFN MCP Bridge > Start Bridge.");
  console.log("  3. Restart Codex and/or Claude Code.");
  console.log("  4. Ask your agent to list MCP tools and call uefn_status.");
  console.log("");
  console.log("Codex troubleshooting: if the MCP appears enabled but tools do not list, fully restart Codex, then rerun pnpm mcp:smoke from this repo.");
}

async function callMcpTool(name, args, timeoutMs) {
  const serverPath = path.join(repoRoot, "src", "server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responses = new Map();
  let stdoutBuffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        responses.set(message.id, message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    sendMcp(child, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "uefn-mcp-installer", version: "0.0.0" }
    });
    await waitForMcpResponse(child, responses, 1, timeoutMs, stderr);
    sendMcpNotification(child, "notifications/initialized", {});
    sendMcp(child, 2, "tools/call", { name, arguments: args });
    return await waitForMcpResponse(child, responses, 2, timeoutMs, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), delay(1000)]).catch(() => {});
    }
  }
}

function sendMcp(child, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function sendMcpNotification(child, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function waitForMcpResponse(child, responses, id, timeoutMs, stderr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (responses.has(id)) {
      return responses.get(id);
    }
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited early with ${child.exitCode}. stderr: ${stderr}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr}`);
}

function parseMcpJsonContent(result) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string");
  if (!textPart) {
    return null;
  }
  try {
    return JSON.parse(textPart.text);
  } catch {
    return null;
  }
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
  const launcher = launcherPath.replaceAll("\\", "/");
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
    let insertIndex = nextLines.findIndex((line) => line.trim() === "[Python]");
    if (insertIndex === -1) {
      if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
        nextLines.push("");
      }
      nextLines.push("[Python]");
      insertIndex = nextLines.length - 1;
    }
    nextLines.splice(insertIndex + 1, 0, `RecentsFiles=${launcher}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${nextLines.join("\n").trimEnd()}\n`, "utf8");
}

function removeManagedBlock(value) {
  const start = value.indexOf(BLOCK_START);
  const end = value.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return value;
  }
  return `${value.slice(0, start)}${value.slice(end + BLOCK_END.length)}`;
}

function getEditorUserSettingsPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  return path.join(localAppData, "UnrealEditorFortnite", "Saved", "Config", "WindowsEditor", "EditorPerProjectUserSettings.ini");
}

async function askYesNo(rl, question, defaultYes) {
  const suffix = defaultYes ? "Y" : "N";
  while (true) {
    const answer = (await rl.question(`${question} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
    console.log("Please answer Y or N.");
  }
}

async function commandExists(command, args, label) {
  const ok = await commandCanRun(command, args);
  if (!ok) {
    throw new Error(`${label} was not found on PATH.`);
  }
  console.log(`  [ok] ${label}`);
}

async function commandCanRun(command, args) {
  try {
    const result = await runCommand(command, args, { cwd: repoRoot, quiet: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`  > ${[command, ...args].join(" ")}`);
  }
  const spawnSpec = buildSpawnSpec(command, args);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.quiet ? "ignore" : "inherit",
    shell: false
  });
  const outcome = await Promise.race([
    once(child, "exit").then(([exitCode]) => ({ exitCode })),
    once(child, "error").then(([error]) => ({ error }))
  ]);
  if (outcome.error) {
    if (!options.quiet) {
      throw new Error(`${options.label ?? command} could not start: ${outcome.error.message}`);
    }
    return { exitCode: 1 };
  }
  const exitCode = outcome.exitCode;
  if (exitCode !== 0 && !options.quiet && options.allowFailure !== true) {
    throw new Error(`${options.label ?? command} failed with exit code ${exitCode}.`);
  }
  return { exitCode };
}

export class RollbackManager {
  constructor(options = {}) {
    this.disabled = options.disabled === true;
    this.operation = options.operation ?? "Installation";
    this.committed = false;
    this.actions = [];
    this.captured = new Set();
    this.backupDir = path.join(os.tmpdir(), `uefn-mcp-installer-${timestampForPath()}`);
  }

  async prepare() {
    if (this.disabled) {
      return;
    }
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  async capture(targetPath) {
    if (this.disabled) {
      return;
    }
    const target = path.resolve(targetPath);
    if (this.captured.has(target)) {
      return;
    }
    this.captured.add(target);

    if (await pathExists(target)) {
      const backupPath = path.join(this.backupDir, `${this.actions.length}-${sanitizeBackupName(target)}`);
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.cp(target, backupPath, { recursive: true, force: true });
      } else {
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(target, backupPath);
      }
      this.actions.push({ kind: "restore", target, backupPath, directory: stat.isDirectory() });
    } else {
      this.actions.push({ kind: "remove", target });
    }
  }

  hasChanges() {
    return !this.disabled && this.actions.length > 0;
  }

  commit() {
    this.committed = true;
  }

  async rollback(error) {
    if (this.disabled || this.actions.length === 0) {
      return;
    }
    step("Rollback", `${this.operation} failed: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  Backups: ${this.backupDir}`);
    for (const action of [...this.actions].reverse()) {
      try {
        if (action.kind === "restore") {
          await fs.rm(action.target, { recursive: true, force: true });
          await fs.mkdir(path.dirname(action.target), { recursive: true });
          if (action.directory) {
            await fs.cp(action.backupPath, action.target, { recursive: true, force: true });
          } else {
            await fs.copyFile(action.backupPath, action.target);
          }
          console.log(`  [ok] Restored ${action.target}`);
        } else if (action.kind === "remove") {
          await fs.rm(action.target, { recursive: true, force: true });
          console.log(`  [ok] Removed ${action.target}`);
        }
      } catch (rollbackError) {
        console.log(`  [warn] Could not rollback ${action.target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
  }
}

function buildSpawnSpec(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")]
  };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '\\"')}"`;
}

function timestampForPath() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeBackupName(value) {
  return String(value).replace(/^[A-Za-z]:/, "").replace(/[\\/:"*?<>|]+/g, "_").replace(/^_+/, "") || "root";
}

async function assertInstallTargetInsideRealRoot(realProjectPath, targetPath, label) {
  const resolvedTarget = path.resolve(targetPath);
  if (await pathExists(resolvedTarget)) {
    await assertExistingPathInsideRealRoot(realProjectPath, resolvedTarget, label);
    return;
  }

  let existingParent = path.dirname(resolvedTarget);
  while (!(await pathExists(existingParent))) {
    const nextParent = path.dirname(existingParent);
    if (nextParent === existingParent) {
      throw new Error(`Refusing to use ${label} because no existing parent could be found: ${resolvedTarget}`);
    }
    existingParent = nextParent;
  }
  await assertExistingPathInsideRealRoot(realProjectPath, existingParent, `${label} parent`);
}

async function assertExistingPathInsideRealRoot(realRoot, candidatePath, label) {
  const resolvedCandidate = path.resolve(candidatePath);
  const lstat = await fs.lstat(resolvedCandidate);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use ${label} because it is a symlink or junction: ${resolvedCandidate}`);
  }
  const realCandidate = await fs.realpath(resolvedCandidate);
  if (!isPathInside(realRoot, realCandidate)) {
    throw new Error(`Refusing to use ${label} because it resolves outside the UEFN project: ${resolvedCandidate}`);
  }
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function escapeTomlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function homeDir() {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

function step(title, detail) {
  console.log("");
  console.log(`[${title}]`);
  if (detail) {
    console.log(`  ${detail}`);
  }
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--project") {
      parsed.project = rawArgs[++index];
    } else if (arg === "--clients") {
      parsed.clients = rawArgs[++index];
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--no-rollback") {
      parsed.noRollback = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: powershell -ExecutionPolicy Bypass -File .\\install.ps1 [--project <path>] [--clients codex|claude|both] [--yes] [--no-rollback]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function isMain() {
  return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isMain()) {
  await main().catch((error) => {
    console.error("");
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
