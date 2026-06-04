import fs from "node:fs/promises";
import path from "node:path";

export async function resolveProject(config, overrideProjectPath) {
  if (!overrideProjectPath && !config.projectPath) {
    throw new Error(
      "No UEFN project path is configured. Set uefnProjectPath in uefn-mcp.config.json, " +
      "set UEFN_PROJECT_PATH, or pass projectPath for validation."
    );
  }
  const projectPath = path.resolve(overrideProjectPath ?? config.projectPath);
  const configuredProjectPath = config.projectPath ? path.resolve(config.projectPath) : null;
  const isOverride = overrideProjectPath !== undefined && configuredProjectPath !== null && projectPath !== configuredProjectPath;
  if (isOverride && config.allowProjectPathOverride !== true) {
    throw new Error(
      "projectPath overrides are disabled. Validate the folder first with uefn_project_summary validateOnly=true, " +
      "then set allowProjectPathOverride=true in uefn-mcp.config.json or UEFN_MCP_ALLOW_PROJECT_PATH_OVERRIDE=true."
    );
  }

  const inspection = await inspectUefnProjectPath(projectPath, {
    contentPath: isOverride ? undefined : config.contentPath
  });
  if (!inspection.safeToAnalyze) {
    throw new Error(`UEFN project validation failed for ${projectPath}: ${inspection.errors.join("; ")}`);
  }

  return {
    projectPath: inspection.projectPath,
    projectName: inspection.projectName,
    contentPath: inspection.contentPath,
    uefnProjectPath: inspection.uefnProjectPath,
    uefnProject: inspection.uefnProject,
    upluginPath: inspection.upluginPath,
    uplugin: inspection.uplugin,
    compatibilityVersion: inspection.compatibilityVersion,
    versePath: inspection.versePath,
    pythonEnabled:
      inspection.pythonEnabled,
    rootPluginName: inspection.rootPluginName,
    validation: compactProjectValidation(inspection)
  };
}

export async function inspectUefnProjectPath(projectPathValue, options = {}) {
  const projectPath = path.resolve(projectPathValue);
  const errors = [];
  const warnings = [];
  const signals = [];
  let entries = [];
  let uefnProjectPath = null;
  let uefnProject = null;
  let rootPluginName = null;
  let upluginPath = null;
  let uplugin = null;

  try {
    const projectStat = await fs.stat(projectPath);
    if (!projectStat.isDirectory()) {
      errors.push("Path is not a directory.");
    }
  } catch (error) {
    errors.push(`Path is not accessible: ${error.message}`);
  }

  if (errors.length === 0) {
    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      errors.push(`Could not list directory: ${error.message}`);
    }
  }

  const projectFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uefnproject"))
    .map((entry) => entry.name);
  if (projectFiles.length === 1) {
    uefnProjectPath = path.join(projectPath, projectFiles[0]);
    signals.push("found .uefnproject");
    try {
      uefnProject = await readJsonFile(uefnProjectPath);
    } catch (error) {
      errors.push(error.message);
    }
  } else if (projectFiles.length === 0) {
    errors.push("Expected one .uefnproject file at the project root, found none.");
  } else {
    errors.push(`Expected one .uefnproject file at the project root, found ${projectFiles.length}.`);
  }

  if (uefnProject) {
    rootPluginName = uefnProject.plugins?.find((plugin) => plugin.bIsRoot === true)?.name ?? path.basename(projectPath);
    upluginPath = path.join(projectPath, `${rootPluginName}.uplugin`);
    try {
      uplugin = await readJsonFile(upluginPath);
      signals.push("found root .uplugin");
    } catch (error) {
      errors.push(`Could not read root .uplugin for ${rootPluginName}: ${error.message}`);
    }
  }

  const contentPath = path.resolve(options.contentPath ?? path.join(projectPath, "Content"));
  if (!isPathInside(projectPath, contentPath)) {
    errors.push(`Content path must stay inside the UEFN project root: ${contentPath}`);
  } else {
    try {
      const contentStat = await fs.stat(contentPath);
      if (contentStat.isDirectory()) {
        signals.push("found Content directory");
      } else {
        errors.push(`Content path is not a directory: ${contentPath}`);
      }
    } catch (error) {
      errors.push(`Content directory is not accessible: ${error.message}`);
    }
  }

  const urcPath = path.join(projectPath, ".urc");
  let hasUnrealRevisionControl = false;
  try {
    const urcStat = await fs.stat(urcPath);
    hasUnrealRevisionControl = urcStat.isDirectory();
    if (hasUnrealRevisionControl) {
      signals.push("found .urc revision-control directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      warnings.push(`Could not inspect .urc directory: ${error.message}`);
    }
  }

  if (!hasUnrealRevisionControl) {
    warnings.push(".urc was not found. This is only an optional Unreal Revision Control signal, not a project requirement.");
  }

  const versePath = uplugin?.VersePath ?? uefnProject?.bindings?.projectVersePath ?? null;
  if (versePath) {
    signals.push("found Verse path metadata");
  }

  const safeToAnalyze = errors.length === 0;
  return {
    ok: safeToAnalyze,
    safeToAnalyze,
    projectPath,
    projectName: uefnProject?.title ?? rootPluginName ?? path.basename(projectPath),
    contentPath,
    uefnProjectPath,
    uefnProject,
    rootPluginName,
    upluginPath,
    uplugin,
    compatibilityVersion: uefnProject?.compatibilityVersion ?? null,
    versePath,
    pythonEnabled:
      uefnProject?.dataSets?.experimental?.pythonExperimental?.bEnablePythonForProject === true,
    hasUnrealRevisionControl,
    signals,
    warnings,
    errors
  };
}

export function compactProjectValidation(inspection) {
  return {
    ok: inspection.ok,
    safeToAnalyze: inspection.safeToAnalyze,
    projectPath: inspection.projectPath,
    projectName: inspection.projectName,
    contentPath: inspection.contentPath,
    uefnProjectPath: inspection.uefnProjectPath,
    rootPluginName: inspection.rootPluginName,
    upluginPath: inspection.upluginPath,
    compatibilityVersion: inspection.compatibilityVersion,
    versePath: inspection.versePath,
    pythonEnabled: inspection.pythonEnabled,
    hasUnrealRevisionControl: inspection.hasUnrealRevisionControl,
    signals: inspection.signals,
    warnings: inspection.warnings,
    errors: inspection.errors
  };
}

export async function projectSummary(config, args = {}) {
  const project = await resolveProject(config, args.projectPath);
  const verseFiles = await listVerseFiles(project.contentPath);
  const limit = clampLimit(args.limit, 5, 200, 40);
  const selected = verseFiles.slice(0, limit);

  return {
    ok: true,
    project: compactProject(project),
    verse: {
      count: verseFiles.length,
      returned: selected.length,
      files: selected.map((file) => verseFileDescriptor(project.contentPath, file))
    },
    resources: {
      verseFiles: "uefn://verse/file/{encodedRelativePath}",
      projectSummary: "uefn://project/summary"
    }
  };
}

export function compactProject(project) {
  return {
    name: project.projectName,
    projectPath: project.projectPath,
    contentPath: project.contentPath,
    compatibilityVersion: project.compatibilityVersion,
    rootPluginName: project.rootPluginName,
    versePath: project.versePath,
    pythonEnabled: project.pythonEnabled
  };
}

export async function listVerseFiles(contentPath) {
  const root = path.resolve(contentPath);
  const results = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".verse")) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results.sort((left, right) => left.localeCompare(right));
}

export async function resolveVerseFile(project, requestedFile) {
  if (typeof requestedFile !== "string" || requestedFile.trim().length === 0) {
    throw new Error("file is required.");
  }

  const requested = requestedFile.trim();
  const root = path.resolve(project.contentPath);
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);

  if (isPathInside(root, candidate) && candidate.toLowerCase().endsWith(".verse")) {
    await fs.access(candidate);
    return candidate;
  }

  const files = await listVerseFiles(root);
  const normalizedRequested = normalizeSlashes(requested).toLowerCase();
  const matches = files.filter((file) => {
    const relative = normalizeSlashes(path.relative(root, file)).toLowerCase();
    return path.basename(file).toLowerCase() === requested.toLowerCase() || relative === normalizedRequested;
  });

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous Verse file: ${requested}`);
  }
  throw new Error(`Verse file not found inside Content: ${requested}`);
}

export async function readVerseFile(project, requestedFile) {
  const filePath = await resolveVerseFile(project, requestedFile);
  const content = await fs.readFile(filePath, "utf8");
  return {
    ok: true,
    file: verseFileDescriptor(project.contentPath, filePath),
    content
  };
}

export async function summarizeVerseArchitecture(project, args = {}) {
  const files = await listVerseFiles(project.contentPath);
  const limit = clampLimit(args.limit, 1, 500, 80);
  const summaries = [];

  for (const file of files.slice(0, limit)) {
    const content = await fs.readFile(file, "utf8");
    summaries.push(summarizeVerseFile(project.contentPath, file, content));
  }

  return {
    ok: true,
    contentPath: project.contentPath,
    totalFiles: files.length,
    returnedFiles: summaries.length,
    files: summaries
  };
}

export async function searchProject(project, args = {}) {
  const query = String(args.query ?? "").trim();
  if (!query) {
    throw new Error("query is required.");
  }

  const limit = clampLimit(args.limit, 1, 100, 20);
  const lower = query.toLowerCase();
  const verseFiles = await listVerseFiles(project.contentPath);
  const matches = [];

  for (const file of verseFiles) {
    const relativePath = normalizeSlashes(path.relative(project.contentPath, file));
    const content = await fs.readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      if (text.toLowerCase().includes(lower)) {
        matches.push({
          type: "verse_line",
          file: relativePath,
          line: index + 1,
          preview: compactLine(text),
          resourceUri: verseFileUri(relativePath)
        });
        if (matches.length >= limit) {
          break;
        }
      }
    }
    if (matches.length >= limit) {
      break;
    }
  }

  return {
    ok: true,
    query,
    scope: "verse",
    count: matches.length,
    matches
  };
}

export function summarizeVerseFile(root, file, content) {
  const lines = content.split(/\r?\n/);
  const classes = [];
  const editables = [];
  const events = [];
  const publicMethods = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const classMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*class(?:\(([^)]*)\))?/);
    if (classMatch) {
      classes.push({ name: classMatch[1], base: classMatch[2] ?? null, line: index + 1 });
    }

    if (line === "@editable" || line === "@editable:") {
      const nextLine = (lines[index + 1] ?? "").trim();
      const editableMatch = nextLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+?)(?:\s*=|$)/);
      if (editableMatch) {
        editables.push({ name: editableMatch[1], type: editableMatch[2].trim(), line: index + 2 });
      }
    }

    const eventMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)<public>\s*:\s*event\(([^)]*)\)/);
    if (eventMatch) {
      events.push({ name: eventMatch[1], payload: eventMatch[2], line: index + 1 });
    }

    const methodMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)<public>\(([^)]*)\)/);
    if (methodMatch) {
      publicMethods.push({ name: methodMatch[1], params: methodMatch[2], line: index + 1 });
    }
  }

  const relativePath = normalizeSlashes(path.relative(root, file));
  return {
    name: path.basename(file),
    relativePath,
    resourceUri: verseFileUri(relativePath),
    lineCount: lines.length,
    classes,
    editables,
    events,
    publicMethods
  };
}

export function verseFileDescriptor(root, file) {
  const relativePath = normalizeSlashes(path.relative(root, file));
  return {
    name: path.basename(file),
    relativePath,
    fullPath: file,
    resourceUri: verseFileUri(relativePath)
  };
}

export function verseFileUri(relativePath) {
  return `uefn://verse/file/${encodeURIComponent(normalizeSlashes(relativePath))}`;
}

export function decodeVerseFileUri(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "uefn:" || parsed.host !== "verse") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "file" || parts.length < 2) {
    return null;
  }
  return decodeURIComponent(parts.slice(1).join("/"));
}

export function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

function compactLine(value) {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function clampLimit(value, min, max, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Expected integer limit, received: ${value}`);
  }
  return Math.max(min, Math.min(max, number));
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}
