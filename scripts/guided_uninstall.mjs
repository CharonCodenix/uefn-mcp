#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { inspectUefnProjectPath } from "../src/lib/project.mjs";
import { RollbackManager } from "./guided_install.mjs";
import {
  applyGuidedUninstallPlan,
  buildProjectUninstallPlan,
  getEditorUserSettingsPath,
  planCodexUninstall,
  planLocalConfigUninstall
} from "./uninstall_helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePythonRoot = path.join(repoRoot, "uefn-plugin", "Content", "Python");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const rollback = new RollbackManager({ disabled: args.noRollback === true, operation: "Uninstallation" });

  try {
    await showIntro();
    step("Welcome", "This uninstaller will explain every planned change before touching anything.");
    printSafetyBoundaries();

    const project = await chooseProject(rl, args.project ?? process.cwd());
    const plan = await buildGuidedUninstallPlan(project, args);
    printPlan(plan, args);
    const plannedActionCount = countPlannedActions(plan);

    if (plannedActionCount === 0) {
      step(args.dryRun ? "Dry run complete" : "Nothing to uninstall", "No matching UEFN MCP managed files or Codex blocks were found for this clone.");
      return;
    }

    if (args.dryRun) {
      step("Dry run complete", "No files were changed.");
      return;
    }

    const confirmed = await askYesNo(rl, "Proceed with uninstalling the UEFN MCP plugin and Codex MCP block? (Y/N)", false);
    if (!confirmed) {
      step("Cancelled", "No files were changed.");
      return;
    }

    await rollback.prepare();
    await applyGuidedUninstallPlan(plan, {
      rollback,
      onActionApplied: (action) => console.log(`  [ok] ${describeAppliedAction(action)}`)
    });
    rollback.commit();
    printSummary(plan);
  } catch (error) {
    if (!rollback.committed && rollback.hasChanges()) {
      await rollback.rollback(error);
    }
    throw error;
  } finally {
    rl.close();
  }
}

export async function buildGuidedUninstallPlan(project, args = {}) {
  const projectPlan = await buildProjectUninstallPlan(project, {
    sourcePythonRoot,
    editorUserSettings: getEditorUserSettingsPath()
  });
  const codexPlan = await planCodexUninstall(path.join(homeDir(), ".codex", "config.toml"), repoRoot);
  const localConfigPlan = args.removeLocalConfig
    ? await planLocalConfigUninstall(path.join(repoRoot, "uefn-mcp.config.json"))
    : null;
  return { projectPlan, codexPlan, localConfigPlan };
}

async function showIntro() {
  const banner = buildThankYouBanner();
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
  console.log("Thank you for using our UEFN MCP. If you had problems with it or it did not work as expected,");
  console.log("we would really appreciate your feedback in the Issues or Discussions tab on GitHub.");
  console.log("");
}

export function buildThankYouBanner() {
  return [
    "  +--------------------------------------------------------------------------------+",
    "  |                                  THANK YOU!                                    |",
    "  | ###### ##   ##   ##   ##   ## ##   ##     ##   ##  ####### ##   ## ##         |",
    "  |   ##   ##   ##  ####  ###  ## ##  ##       ## ##  ##    ## ##   ## ##         |",
    "  |   ##   ##   ## ##  ## #### ## ## ##         ###   ##    ## ##   ## ##         |",
    "  |   ##   ####### ###### ## #### ####           ##   ##    ## ##   ## ##         |",
    "  |   ##   ##   ## ##  ## ##  ### ## ##          ##   ##    ## ##   ##            |",
    "  |   ##   ##   ## ##  ## ##   ## ##  ##         ##   ##    ## ##   ## ##         |",
    "  |   ##   ##   ## ##  ## ##   ## ##   ##        ##    #######  #####  ##         |",
    "  +--------------------------------------------------------------------------------+"
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
    throw new Error("Please rerun this uninstaller from the UEFN project root or pass --project.");
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
      throw new Error("Please rerun this uninstaller with a valid UEFN project path.");
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
}

function printSafetyBoundaries() {
  console.log("");
  console.log("Safety boundaries:");
  console.log("  - This will not delete your repo clone, node_modules, pnpm, island content, or Claude config.");
  console.log("  - This will not disable UEFN Python, because other workflows may depend on it.");
  console.log("  - It removes only managed UEFN MCP files and this clone's Codex MCP block.");
}

function printPlan(plan, args) {
  step(args.dryRun ? "Dry-run plan" : "Planned removals", "Review these actions before confirming.");
  printActionGroup("UEFN project", plan.projectPlan.actions, plan.projectPlan.skipped);
  printActionGroup("Codex config", plan.codexPlan.actions, plan.codexPlan.skipped);
  if (plan.localConfigPlan) {
    printActionGroup("Local config", plan.localConfigPlan.actions, plan.localConfigPlan.skipped);
  } else {
    console.log("  [skip] Local uefn-mcp.config.json will be kept. Pass --remove-local-config to remove it safely.");
  }
}

function printActionGroup(title, actions, skipped) {
  console.log("");
  console.log(`  ${title}:`);
  for (const action of actions) {
    console.log(`    [remove] ${describePlannedAction(action)}`);
  }
  for (const item of skipped) {
    console.log(`    [skip] ${item.reason}`);
  }
  if (actions.length === 0 && skipped.length === 0) {
    console.log("    [skip] Nothing found.");
  }
}

function countPlannedActions(plan) {
  return plan.projectPlan.actions.length
    + plan.codexPlan.actions.length
    + (plan.localConfigPlan?.actions.length ?? 0);
}

function describePlannedAction(action) {
  if (action.action === "remove_package") {
    return `UEFN Python package: ${action.path}`;
  }
  if (action.action === "remove_launcher") {
    return `UEFN launcher script: ${action.path}`;
  }
  if (action.action === "remove_init_block") {
    return action.deleteFile
      ? `managed init_unreal.py block and empty file: ${action.path}`
      : `managed init_unreal.py block: ${action.path}`;
  }
  if (action.action === "remove_python_recent_script") {
    return `UEFN recent-script entry: ${action.script}`;
  }
  if (action.action === "remove_codex_mcp_block") {
    return `this clone's Codex uefn-mcp block: ${action.path}`;
  }
  if (action.action === "remove_local_config") {
    return `generated local config: ${action.path}`;
  }
  return `${action.action}: ${action.path}`;
}

function describeAppliedAction(action) {
  if (action.action === "remove_package") {
    return `Removed UEFN Python package: ${action.path}`;
  }
  if (action.action === "remove_launcher") {
    return `Removed launcher script: ${action.path}`;
  }
  if (action.action === "remove_init_block") {
    return action.deleteFile ? `Removed empty init_unreal.py: ${action.path}` : `Removed managed init_unreal.py block: ${action.path}`;
  }
  if (action.action === "remove_python_recent_script") {
    return `Removed UEFN recent-script entry from ${action.path}`;
  }
  if (action.action === "remove_codex_mcp_block") {
    return `Removed Codex MCP block from ${action.path}`;
  }
  if (action.action === "remove_local_config") {
    return `Removed generated local config: ${action.path}`;
  }
  return `${action.action}: ${action.path}`;
}

function printSummary(plan) {
  step("Uninstall complete", "UEFN MCP managed files have been removed where they were found.");
  console.log(`  Project actions: ${plan.projectPlan.actions.length}`);
  console.log(`  Codex actions: ${plan.codexPlan.actions.length}`);
  if (plan.localConfigPlan) {
    console.log(`  Local config actions: ${plan.localConfigPlan.actions.length}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart UEFN if it was open.");
  console.log("  2. Fully restart Codex so it reloads MCP configuration.");
  console.log("  3. If something did not work as expected, please share feedback in GitHub Issues or Discussions.");
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
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--remove-local-config") {
      parsed.removeLocalConfig = true;
    } else if (arg === "--no-rollback") {
      parsed.noRollback = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1 [--project <path>] [--dry-run] [--remove-local-config] [--no-rollback]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function homeDir() {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
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
