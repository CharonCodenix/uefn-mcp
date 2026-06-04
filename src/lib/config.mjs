import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const SERVER_NAME = "uefn-mcp";
export const SERVER_VERSION = "1.0.0";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";
export const DEFAULT_VERSE_WORKFLOW_HOST = "127.0.0.1";
export const DEFAULT_VERSE_WORKFLOW_PORT = 1962;

export const DEFAULT_UEFN_LOG_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "UnrealEditorFortnite", "Saved", "Logs", "UnrealEditorFortnite.log")
  : undefined;

export async function loadConfig(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, "uefn-mcp.config.json");
  let fileConfig = {};

  try {
    fileConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read ${configPath}: ${error.message}`);
    }
  }

  const projectPath =
    process.env.UEFN_PROJECT_PATH ??
    fileConfig.uefnProjectPath ??
    inferProjectPathFromContent(fileConfig.airKingsContentPath);

  return {
    projectPath: projectPath ? path.resolve(projectPath) : undefined,
    contentPath: process.env.UEFN_CONTENT_PATH ?? fileConfig.contentPath ?? fileConfig.airKingsContentPath,
    bridgeUrl: process.env.UEFN_BRIDGE_URL ?? fileConfig.bridgeUrl ?? DEFAULT_BRIDGE_URL,
    verseWorkflowHost: process.env.UEFN_VERSE_WORKFLOW_HOST ?? fileConfig.verseWorkflowHost ?? DEFAULT_VERSE_WORKFLOW_HOST,
    verseWorkflowPort:
      parseOptionalInteger(process.env.UEFN_VERSE_WORKFLOW_PORT) ??
      fileConfig.verseWorkflowPort ??
      DEFAULT_VERSE_WORKFLOW_PORT,
    uefnLogPath: process.env.UEFN_LOG_PATH ?? fileConfig.uefnLogPath ?? DEFAULT_UEFN_LOG_PATH,
    resourceCacheDir:
      process.env.UEFN_MCP_RESOURCE_CACHE_DIR ??
      fileConfig.resourceCacheDir ??
      path.join(cwd, ".uefn-mcp-cache"),
    bridgeBootstrapPort:
      parseOptionalInteger(process.env.UEFN_BRIDGE_BOOTSTRAP_PORT) ??
      fileConfig.bridgeBootstrapPort ??
      8766,
    allowProjectPathOverride:
      parseOptionalBoolean(process.env.UEFN_MCP_ALLOW_PROJECT_PATH_OVERRIDE) ??
      fileConfig.allowProjectPathOverride === true,
    allowExternalLogPath:
      parseOptionalBoolean(process.env.UEFN_MCP_ALLOW_EXTERNAL_LOG_PATH) ??
      fileConfig.allowExternalLogPath === true
  };
}

function inferProjectPathFromContent(contentPath) {
  if (!contentPath) {
    return undefined;
  }
  const resolved = path.resolve(contentPath);
  return path.basename(resolved).toLowerCase() === "content" ? path.dirname(resolved) : undefined;
}

export function parseOptionalInteger(value) {
  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

export function parseOptionalBoolean(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function clampInteger(value, min, max, name = "value") {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Expected integer for ${name}, received: ${value}`);
  }
  return Math.max(min, Math.min(max, number));
}

export function normalizedBridgeUrl(config) {
  return config.bridgeUrl.endsWith("/") ? config.bridgeUrl : `${config.bridgeUrl}/`;
}
