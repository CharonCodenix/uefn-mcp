import path from "node:path";
import * as z from "zod/v4";
import { bridgeHealth, bridgePost } from "./bridge_client.mjs";
import { clampInteger } from "./config.mjs";
import { focusUefnEditor } from "./focus_editor.mjs";
import {
  compactProject,
  compactProjectValidation,
  inspectUefnProjectPath,
  projectSummary,
  readVerseFile,
  resolveProject,
  searchProject,
  summarizeVerseArchitecture
} from "./project.mjs";
import { readVerseDiagnostics, tailLog } from "./verse_diagnostics.mjs";
import { compileVerseViaWorkflow, probeVerseWorkflow } from "./verse_workflow.mjs";

const ACTOR_RANKING_DESCRIPTION = "selected > Verse devices > UEFN devices > CustomCreativeDevices/important gameplay names > generic meshes";
const ActorMatchBySchema = z.enum(["label", "name", "path", "auto"]);
const ActorUpdateOperationSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["set", "add"]),
  value: z.any()
}).strict();

export function registerUefnTools(server, config, store) {
  const tools = [
    {
      name: "uefn_status",
      description: "Check configured UEFN project, Python bridge, and Verse workflow server status. Compact by default.",
      inputSchema: {
        detailLevel: z.enum(["summary", "detail"]).optional(),
        projectPath: z.string().optional()
      },
      handler: (args) => statusTool(config, args)
    },
    {
      name: "uefn_project_summary",
      description: "Summarize the configured UEFN project and Verse files compactly. Full architecture is stored as a resource when requested.",
      inputSchema: {
        projectPath: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        includeArchitecture: z.boolean().optional(),
        validateOnly: z.boolean().optional()
      },
      handler: (args) => projectSummaryTool(config, args, store)
    },
    {
      name: "uefn_search",
      description: "Search Verse files or bridge scene actors using compact top matches and resource URIs.",
      inputSchema: {
        query: z.string(),
        scope: z.enum(["verse", "scene", "all"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        projectPath: z.string().optional()
      },
      handler: (args) => searchTool(config, args)
    },
    {
      name: "uefn_read_resource",
      description: "Read a UEFN MCP resource by URI. Defaults to compact text with truncation; request full=true only when the full resource is needed.",
      inputSchema: {
        uri: z.string(),
        full: z.boolean().optional(),
        maxChars: z.number().int().min(200).max(200000).optional()
      },
      handler: (args) => readResourceTool(store, args)
    },
    {
      name: "uefn_scene_context",
      description: "Capture compact structured scene context from UEFN. Large snapshots are stored as resources.",
      inputSchema: {
        nameContains: z.string().optional(),
        classContains: z.string().optional(),
        folder: z.string().optional(),
        includeSelection: z.boolean().optional(),
        detailLevel: z.enum(["summary", "detail"]).optional(),
        limit: z.number().int().min(1).max(500).optional()
      },
      handler: (args) => sceneContextTool(config, args, store)
    },
    {
      name: "uefn_get_actor_details",
      description: "Inspect one UEFN actor with identity, transform, writable metadata, optional editor properties, and optional components.",
      inputSchema: {
        actor: z.string().min(1),
        matchBy: ActorMatchBySchema.optional(),
        includeProperties: z.boolean().optional(),
        includeComponents: z.boolean().optional(),
        filter: z.string().optional(),
        detailLevel: z.enum(["summary", "detail"]).optional()
      },
      handler: (args) => getActorDetailsTool(config, args, store)
    },
    {
      name: "uefn_update_actor",
      description: "Dry-run or apply expressive actor edits using friendly paths such as transform.location.z, label, properties.foo, or components[0].properties.foo.",
      inputSchema: {
        actor: z.string().min(1),
        matchBy: ActorMatchBySchema.optional(),
        dryRun: z.boolean().optional(),
        operations: z.array(ActorUpdateOperationSchema).min(1).max(100)
      },
      handler: (args) => updateActorTool(config, args, store)
    },
    {
      name: "uefn_visual_context",
      description: "Capture viewport or camera screenshot context from UEFN and return image resource metadata instead of inline image data.",
      inputSchema: {
        cameraName: z.string().optional(),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(180).max(2160).optional(),
        waitMs: z.number().int().min(0).max(120000).optional(),
        focusEditor: z.boolean().optional(),
        includeSceneSummary: z.boolean().optional()
      },
      handler: (args) => visualContextTool(config, args, store)
    },
    {
      name: "uefn_compile_verse",
      description: "Compile Verse through UEFN's Verse Workflow Server, then read compact diagnostics from UnrealEditorFortnite.log.",
      inputSchema: {
        waitMs: z.number().int().min(0).max(30000).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        maxDiagnostics: z.number().int().min(1).max(500).optional(),
        compact: z.boolean().optional(),
        logPath: z.string().optional()
      },
      handler: (args) => compileVerseTool(config, args, store)
    },
    {
      name: "uefn_diagnostics",
      description: "Read compact Verse diagnostics or recent log lines from UnrealEditorFortnite.log.",
      inputSchema: {
        mode: z.enum(["verse", "tail"]).optional(),
        lines: z.number().int().min(1).max(2000).optional(),
        sinceLine: z.number().int().min(1).optional(),
        maxDiagnostics: z.number().int().min(1).max(500).optional(),
        includeRaw: z.boolean().optional(),
        compact: z.boolean().optional(),
        filter: z.enum(["verse_build", "all"]).optional(),
        logPath: z.string().optional()
      },
      handler: (args) => diagnosticsTool(config, args, store)
    },
    {
      name: "uefn_run_python",
      description: "Run UEFN editor Python with a mandatory dry-run. Clean dry-runs auto-execute; warnings return a dryRunId required for execute.",
      inputSchema: {
        mode: z.enum(["dry_run", "execute"]).optional(),
        script: z.string().min(1).max(100000),
        dryRunId: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
      },
      handler: (args) => runPythonTool(config, args, store)
    },
  ];

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async (args) => {
        try {
          return toolResult(await tool.handler(args ?? {}));
        } catch (error) {
          return toolResult(errorPayload(error), true);
        }
      }
    );
  }
}

async function statusTool(config, args = {}) {
  const [projectResult, bridge, workflow] = await Promise.allSettled([
    resolveProject(config, args.projectPath),
    bridgeHealth(config),
    probeVerseWorkflow(config)
  ]);

  const project = projectResult.status === "fulfilled"
    ? { ok: true, ...compactProject(projectResult.value) }
    : { ok: false, error: projectResult.reason?.message ?? String(projectResult.reason) };

  const detail = args.detailLevel === "detail";
  return {
    ok: project.ok && settledValue(bridge)?.ok === true,
    project,
    bridge: compactBridgeStatus(settledObject(bridge), detail),
    verseWorkflow: compactWorkflowStatus(settledObject(workflow)),
    nextStep: settledValue(bridge)?.ok
      ? null
      : "Open UEFN and click UEFN MCP Bridge > Start Bridge. If the launcher is missing, run pnpm uefn:install -- --project <path>."
  };
}

async function projectSummaryTool(config, args, store) {
  if (args.validateOnly === true) {
    if (!args.projectPath && !config.projectPath) {
      throw new Error("projectPath is required for validation when no uefnProjectPath is configured.");
    }
    const inspection = await inspectUefnProjectPath(args.projectPath ?? config.projectPath, {
      contentPath: args.projectPath ? undefined : config.contentPath
    });
    return {
      ok: inspection.ok,
      validation: compactProjectValidation(inspection),
      nextStep: inspection.safeToAnalyze
        ? "This path looks like a UEFN project. Configure it as uefnProjectPath, or enable allowProjectPathOverride before analysis."
        : "Do not analyze this folder until the validation errors are fixed."
    };
  }

  const summary = await projectSummary(config, { ...args, limit: args.limit ?? 8 });
  const compactSummary = compactProjectSummary(summary);
  if (args.includeArchitecture === true) {
    const project = await resolveProject(config, args.projectPath);
    const architecture = await summarizeVerseArchitecture(project, { limit: args.limit });
    const resourceUri = store.addJson("project-summary", { summary, architecture }, { name: "project-summary" });
    return {
      ...compactSummary,
      architecture: {
        totalFiles: architecture.totalFiles,
        returnedFiles: architecture.returnedFiles,
        files: architecture.files.slice(0, 2).map(compactArchitectureFile),
        omittedFiles: Math.max(0, architecture.files.length - 2),
        resourceUri
      }
    };
  }
  return compactSummary;
}

async function searchTool(config, args) {
  const scope = args.scope ?? "verse";
  const project = await resolveProject(config, args.projectPath);
  const limit = args.limit ?? 10;
  const results = [];

  if (scope === "verse" || scope === "all") {
    results.push(await searchProject(project, { ...args, limit }));
  }

  if (scope === "scene" || scope === "all") {
    try {
      const scene = await bridgePost(config, "list_actors", {
        nameContains: args.query,
        limit
      }, 30000);
      results.push({
        ok: true,
        scope: "scene",
        query: args.query,
        count: scene.count ?? scene.actors?.length ?? 0,
        totalMatches: scene.totalMatches ?? null,
        ranking: scene.ranking ?? ACTOR_RANKING_DESCRIPTION,
        matches: prioritizeActorsForContext(scene.actors ?? [], scene.selection ?? []).map(compactActor)
      });
    } catch (error) {
      results.push(errorPayload(error));
    }
  }

  return {
    ok: results.some((result) => result.ok),
    scope,
    results
  };
}

async function readResourceTool(store, args) {
  const resource = await store.read(args.uri);
  const full = args.full === true;
  const maxChars = clampInteger(args.maxChars ?? 12000, 200, 200000, "maxChars");
  if (full) {
    return {
      ok: true,
      uri: args.uri,
      full: true,
      contents: resource.contents
    };
  }

  const compactContents = resource.contents.map((content) => compactResourceContent(content, maxChars));
  return {
    ok: true,
    uri: args.uri,
    full: false,
    maxChars,
    contents: compactContents,
    nextStep: compactContents.some((content) => content.truncated)
      ? "Call uefn_read_resource with full=true or a higher maxChars only if the omitted content is needed."
      : null
  };
}

async function sceneContextTool(config, args, store) {
  const response = await bridgePost(config, "scene_context", {
    ...args,
    limit: args.limit ?? 25,
    detailLevel: args.detailLevel ?? "summary"
  }, 45000);
  const resourceUri = store.addJson("scene/snapshot", response, {
    name: response.snapshotId ?? "scene-snapshot"
  });
  const actors = prioritizeActorsForContext(response.actors ?? [], response.selection ?? []);
  const isTargeted = Boolean(args.nameContains || args.classContains || args.folder || args.includeSelection);
  const immediateActorLimit = args.detailLevel === "detail"
    ? Math.min(args.limit ?? 25, 50)
    : isTargeted
      ? Math.min(args.limit ?? 10, 20)
      : Math.min(args.limit ?? 5, 8);
  const returnedActors = actors.slice(0, immediateActorLimit).map((actor) => compactActor(actor, {
    includePath: args.detailLevel === "detail"
  }));

  return {
    ok: response.ok !== false,
    snapshotId: response.snapshotId ?? null,
    resourceUri,
    summary: response.summary ?? {
      actorCount: response.actorCount ?? response.actors?.length ?? null,
      returnedActors: response.actors?.length ?? null
    },
    ranking: response.ranking ?? ACTOR_RANKING_DESCRIPTION,
    actors: returnedActors,
    omittedActors: Math.max(0, actors.length - returnedActors.length),
    nextStep: actors.length > returnedActors.length
      ? "Use the resourceUri or add nameContains/classContains/folder filters for the remaining actors."
      : null
  };
}

async function visualContextTool(config, args, store) {
  const focusAttempt = await focusUefnEditor(args.focusEditor !== false);
  const response = await bridgePost(config, "visual_context", {
    width: args.width ?? 1280,
    height: args.height ?? 720,
    waitMs: args.waitMs ?? 30000,
    cameraName: args.cameraName,
    includeSceneSummary: args.includeSceneSummary !== false
  }, 60000);

  if (response.screenshotPath) {
    const uri = response.resourceUri ?? `uefn://visual/${encodeURIComponent(path.basename(response.screenshotPath))}`;
    store.addFile(uri, response.screenshotPath, {
      name: path.basename(response.screenshotPath),
      mimeType: "image/png"
    });
    response.resourceUri = uri;
  }

  return {
    ok: response.ok !== false,
    resourceUri: response.resourceUri ?? null,
    screenshotPath: response.screenshotPath ?? null,
    capture: response.capture ?? null,
    focusAttempt: compactFocusAttempt(focusAttempt),
    sceneSummary: response.sceneSummary ?? null,
    attempts: summarizeAttempts(response.attempts ?? []),
    nextStep: response.ok === false
      ? "If the screenshot is pending, focus the UEFN viewport and retry with focusEditor=true and a longer waitMs."
      : null
  };
}

async function compileVerseTool(config, args, store) {
  const before = await safeDiagnostics(config, args, { maxDiagnostics: 1, compact: true });
  const startLine = before?.totalLines ? before.totalLines + 1 : args.sinceLine;
  let trigger;

  try {
    trigger = await compileVerseViaWorkflow(config, { timeoutMs: args.timeoutMs ?? 30000 });
  } catch (workflowError) {
    trigger = {
      ok: false,
      source: "verse_workflow_server",
      error: workflowError instanceof Error ? workflowError.message : String(workflowError)
    };
    try {
      const fallback = await bridgePost(config, "compile_verse", {}, args.timeoutMs ?? 30000);
      trigger.fallback = {
        ok: fallback.ok !== false,
        source: "uefn_python_bridge",
        result: fallback
      };
    } catch (bridgeError) {
      trigger.fallback = errorPayload(bridgeError);
    }
  }

  const waitMs = clampInteger(args.waitMs ?? 2000, 0, 30000, "waitMs");
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const diagnostics = await safeDiagnostics(config, {
    ...args,
    sinceLine: startLine,
    maxDiagnostics: args.maxDiagnostics ?? 20,
    compact: args.compact !== false
  });
  const logResourceUri = diagnostics
    ? store.addJson("logs/verse", diagnostics, { name: "verse-diagnostics" })
    : null;
  const triggerOk = trigger.ok === true || trigger.fallback?.ok === true;
  const failed = diagnostics?.summary?.latestStatus === "FAILED" || (diagnostics?.errorCount ?? 0) > 0;

  return {
    ok: triggerOk && !failed,
    trigger: compactCompileTrigger(trigger),
    waitedMs: waitMs,
    diagnostics: diagnostics?.diagnostics ?? [],
    summary: diagnostics?.summary ?? null,
    logResourceUri,
    nextStep: triggerOk
      ? null
      : "Open UEFN and confirm the Verse Workflow Server is available. VS Code's Verse extension should be able to connect before this tool can compile directly."
  };
}

async function diagnosticsTool(config, args, store) {
  const mode = args.mode ?? "verse";
  const effectiveArgs = mode === "tail"
    ? { ...args, lines: args.lines ?? 10 }
    : args;
  const result = mode === "tail"
    ? await tailLog(effectiveArgs, config)
    : await readVerseDiagnostics(effectiveArgs, config);
  const resourceUri = store.addJson(mode === "tail" ? "logs/tail" : "logs/verse", result, {
    name: mode === "tail" ? "tail-log" : "verse-diagnostics"
  });
  return compactDiagnosticsResult(result, mode, resourceUri);
}

async function runPythonTool(config, args, store) {
  const mode = args.mode ?? "dry_run";
  if (mode === "execute") {
    const execution = await bridgePost(config, "python_execute", args, args.timeoutMs ?? 30000);
    const resourceUri = store.addJson("python/execute", execution, {
      id: execution.executionId ?? execution.dryRunId,
      name: execution.dryRunId ? `python-execute-${execution.dryRunId}` : "python-execute"
    });
    return {
      ok: execution.ok !== false,
      mode,
      autoExecuted: false,
      dryRunId: execution.dryRunId ?? args.dryRunId ?? null,
      scriptHash: execution.scriptHash ?? null,
      outputPreview: execution.outputPreview ?? null,
      stderrPreview: execution.stderrPreview ?? null,
      resourceUri,
      nextStep: execution.nextStep ?? null
    };
  }

  const dryRun = await bridgePost(config, "python_dry_run", args, args.timeoutMs ?? 30000);
  const warnings = dryRun.warnings ?? [];
  const blocked = dryRun.blocked === true || dryRun.ok === false;
  if (blocked || warnings.length > 0) {
    const resourceUri = store.addJson("python/dry-run", dryRun, {
      id: dryRun.dryRunId,
      name: dryRun.dryRunId ? `python-dry-run-${dryRun.dryRunId}` : "python-dry-run"
    });
    return {
      ok: dryRun.ok !== false && !blocked,
      mode: "dry_run",
      autoExecuted: false,
      requiresDryRunId: dryRun.ok !== false && warnings.length > 0,
      dryRunId: dryRun.dryRunId ?? null,
      scriptHash: dryRun.scriptHash ?? null,
      warnings,
      blocked,
      imports: dryRun.imports ?? [],
      callsPreview: dryRun.callsPreview ?? [],
      error: dryRun.error ?? null,
      resourceUri,
      nextStep: dryRun.nextStep ?? (
        warnings.length > 0
          ? "Review the warnings. If they are acceptable, call uefn_run_python with mode=execute, the same script, and this dryRunId."
          : null
      )
    };
  }

  const execution = await bridgePost(config, "python_execute", {
    ...args,
    mode: "execute",
    dryRunId: dryRun.dryRunId
  }, args.timeoutMs ?? 30000);
  const resourceUri = store.addJson("python/auto-execute", { dryRun, execution }, {
    id: dryRun.dryRunId,
    name: dryRun.dryRunId ? `python-auto-${dryRun.dryRunId}` : "python-auto-execute"
  });
  return {
    ok: execution.ok !== false,
    mode: "dry_run",
    autoExecuted: true,
    dryRunId: dryRun.dryRunId ?? null,
    scriptHash: dryRun.scriptHash ?? execution.scriptHash ?? null,
    warnings,
    blocked: false,
    outputPreview: execution.outputPreview ?? null,
    stderrPreview: execution.stderrPreview ?? null,
    resourceUri,
    nextStep: execution.nextStep ?? null
  };
}

async function getActorDetailsTool(config, args, store) {
  const response = await bridgePost(config, "actor_details", {
    ...args,
    matchBy: args.matchBy ?? "label",
    includeComponents: args.includeComponents !== false,
    includeProperties: args.includeProperties === true,
    detailLevel: args.detailLevel ?? "summary"
  }, 60000);
  const resourceUri = store.addJson("scene/actor-details", response, {
    name: response.actor?.label ? `actor-details-${response.actor.label}` : "actor-details"
  });
  return compactActorDetailsForResponse(response, resourceUri);
}

async function updateActorTool(config, args, store) {
  const response = await bridgePost(config, "update_actor", {
    ...args,
    matchBy: args.matchBy ?? "label",
    dryRun: args.dryRun !== false
  }, 60000);
  const resourceUri = store.addJson("scene/actor-updates", response, {
    name: response.actor?.label ? `actor-update-${response.actor.label}` : "actor-update"
  });
  return compactActorUpdateForResponse(response, resourceUri);
}

export function compactActorDetailsForResponse(response, resourceUri = null) {
  const properties = response.properties ?? [];
  const components = response.components ?? [];
  return {
    ok: response.ok !== false,
    actor: response.actor ? compactActor(response.actor, { includePath: true }) : null,
    transform: response.transform ?? null,
    properties: properties.slice(0, 20).map(compactActorProperty),
    omittedProperties: Math.max(0, properties.length - 20),
    components: components.slice(0, 12).map(compactActorComponent),
    omittedComponents: Math.max(0, components.length - 12),
    propertyCount: response.propertyCount ?? properties.length,
    componentCount: response.componentCount ?? components.length,
    warnings: response.warnings ?? [],
    candidates: (response.candidates ?? []).slice(0, 10).map((actor) => compactActor(actor, { includePath: true })),
    omittedCandidates: Math.max(0, (response.candidates ?? []).length - 10),
    componentCandidates: (response.componentCandidates ?? []).slice(0, 10).map(compactActorComponent),
    omittedComponentCandidates: Math.max(0, (response.componentCandidates ?? []).length - 10),
    resourceUri,
    error: response.error ?? null,
    nextStep: response.nextStep ?? null
  };
}

export function compactActorUpdateForResponse(response, resourceUri = null) {
  const changes = response.changes ?? [];
  return {
    ok: response.ok !== false,
    dryRun: response.dryRun !== false,
    actor: response.actor ? compactActor(response.actor, { includePath: true }) : null,
    changedCount: response.changedCount ?? 0,
    operationCount: response.operationCount ?? changes.length,
    changes: changes.slice(0, 20).map(compactActorUpdateChange),
    omittedChanges: Math.max(0, changes.length - 20),
    warnings: response.warnings ?? [],
    candidates: (response.candidates ?? []).slice(0, 10).map((actor) => compactActor(actor, { includePath: true })),
    omittedCandidates: Math.max(0, (response.candidates ?? []).length - 10),
    componentCandidates: (response.componentCandidates ?? []).slice(0, 10).map(compactActorComponent),
    omittedComponentCandidates: Math.max(0, (response.componentCandidates ?? []).length - 10),
    resourceUri,
    error: response.error ?? null,
    nextStep: response.nextStep ?? null
  };
}

async function safeDiagnostics(config, args, defaults = {}) {
  try {
    return await readVerseDiagnostics({ ...defaults, ...args }, config);
  } catch {
    return null;
  }
}

function toolResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value,
    isError
  };
}

function errorPayload(error) {
  const message = error instanceof Error ? error.message : String(error);
  const bridgeResponse = error?.bridgeResponse;
  const payload = {
    ok: false,
    error: compactErrorMessage(message),
    nextStep: shortNextStep(error?.nextStep, message)
  };
  if (error?.bridgeTool) {
    payload.bridgeTool = error.bridgeTool;
    payload.httpStatus = error.httpStatus;
    payload.bridgeError = compactErrorMessage(bridgeResponse?.error ?? message);
  }
  return payload;
}

function compactBridgeStatus(bridge, detail) {
  if (!bridge || bridge.ok === false) {
    return bridge;
  }
  const body = bridge.body ?? {};
  return {
    ok: true,
    bridgeUrl: bridge.bridgeUrl,
    status: bridge.status,
    service: body.service ?? null,
    version: body.version ?? null,
    unrealAvailable: body.unrealAvailable ?? null,
    menuRegistered: body.menuRegistered ?? null,
    ...(detail ? { menuTargets: body.menuTargets ?? [] } : {})
  };
}

function compactWorkflowStatus(workflow) {
  if (!workflow || workflow.ok === false) {
    return workflow;
  }
  return {
    ok: true,
    host: workflow.host,
    port: workflow.port,
    protocol: workflow.protocol
  };
}

function compactProjectSummary(summary) {
  return {
    ok: summary.ok,
    project: compactProjectForResponse(summary.project),
    verse: compactVerseSummary(summary.verse),
    resources: summary.resources
  };
}

function compactProjectForResponse(project) {
  return {
    name: project.name,
    compatibilityVersion: project.compatibilityVersion,
    rootPluginName: project.rootPluginName,
    versePath: project.versePath,
    pythonEnabled: project.pythonEnabled
  };
}

function compactVerseSummary(verse) {
  const files = verse.files ?? [];
  const shown = files.slice(0, 6);
  return {
    count: verse.count,
    returned: shown.length,
    availableFromSummary: files.length,
    files: shown.map((file) => ({
      name: file.name,
      relativePath: file.relativePath,
      resourceUri: file.resourceUri
    })),
    omittedFiles: Math.max(0, (verse.count ?? files.length) - shown.length)
  };
}

function compactArchitectureFile(file) {
  return {
    name: file.name,
    relativePath: file.relativePath,
    resourceUri: file.resourceUri,
    lineCount: file.lineCount,
    classes: (file.classes ?? []).slice(0, 5).map(({ name, base, line }) => ({ name, base, line })),
    editableCount: file.editables?.length ?? 0,
    eventCount: file.events?.length ?? 0,
    publicMethodCount: file.publicMethods?.length ?? 0
  };
}

function compactActor(actor, options = {}) {
  return {
    name: actor.name,
    label: actor.label,
    class: actor.class,
    folder: actor.folder,
    ...(options.includePath ? { path: actor.path } : {})
  };
}

export function prioritizeActorsForContext(actors, selection = []) {
  const selectedKeys = new Set();
  for (const actor of selection) {
    for (const key of actorIdentityKeys(actor)) {
      if (key) {
        selectedKeys.add(key);
      }
    }
  }

  return actors
    .map((actor, index) => ({ actor, index }))
    .sort((left, right) => {
      const leftScore = actorImportanceScore(left.actor, selectedKeys);
      const rightScore = actorImportanceScore(right.actor, selectedKeys);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return actorTieBreak(left.actor, left.index).localeCompare(actorTieBreak(right.actor, right.index));
    })
    .map((entry) => entry.actor);
}

function actorImportanceScore(actor, selectedKeys) {
  const name = String(actor.name ?? "").toLowerCase();
  const label = String(actor.label ?? "").toLowerCase();
  const className = String(actor.class ?? "").toLowerCase();
  const folder = String(actor.folder ?? "").toLowerCase().replaceAll("\\", "/");
  const text = `${name} ${label} ${className} ${folder}`;
  let score = 1000;

  if (actorIdentityKeys(actor).some((key) => selectedKeys.has(key))) {
    score -= 1000;
  }
  if (className.includes("versedevice") || text.includes("verse device")) {
    score -= 650;
  }
  if (className.startsWith("device_") || className.includes("_device") || className.includes("device_")) {
    score -= 520;
  }
  if (folder.includes("customcreativedevices") || folder.includes("custom creative devices")) {
    score -= 320;
  }
  if (IMPORTANT_ACTOR_TERMS.some((term) => text.includes(term))) {
    score -= 220;
  }
  if (GENERIC_ACTOR_TERMS.some((term) => text.includes(term))) {
    score += 450;
  }

  return score;
}

const IMPORTANT_ACTOR_TERMS = [
  "manager",
  "tracker",
  "meter",
  "lane",
  "round",
  "economy",
  "input",
  "booster",
  "launch",
  "weapon",
  "receptionist",
  "trigger",
  "launcher",
  "impulsador",
  "activador"
];

const GENERIC_ACTOR_TERMS = [
  "worlddatalayers",
  "staticmeshactor",
  "fortstaticmeshactor",
  "basic_tile",
  "basictile",
  "floors_generic",
  "cuadrosx",
  "test",
  "prototype"
];

function actorIdentityKeys(actor) {
  return [
    String(actor.name ?? ""),
    String(actor.label ?? ""),
    String(actor.path ?? "")
  ].filter(Boolean);
}

function actorTieBreak(actor, index) {
  return [
    String(actor.folder ?? "").toLowerCase(),
    String(actor.label ?? "").toLowerCase(),
    String(actor.name ?? "").toLowerCase(),
    String(index).padStart(8, "0")
  ].join("|");
}

function compactResourceContent(content, maxChars) {
  if (content.blob) {
    return {
      uri: content.uri,
      mimeType: content.mimeType,
      kind: "blob",
      omitted: true,
      byteLengthApprox: Math.floor(content.blob.length * 0.75),
      note: "Binary content omitted from compact response. Request full=true to retrieve the blob."
    };
  }

  const text = content.text ?? "";
  const truncated = text.length > maxChars;
  return {
    uri: content.uri,
    mimeType: content.mimeType,
    text: truncated ? `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]` : text,
    charCount: text.length,
    truncated
  };
}

function compactFocusAttempt(focusAttempt) {
  if (!focusAttempt) {
    return null;
  }
  return {
    ok: focusAttempt.ok === true,
    skipped: focusAttempt.skipped === true,
    reason: focusAttempt.reason ?? null,
    windowTitle: focusAttempt.windowTitle ?? null
  };
}

function summarizeAttempts(attempts) {
  const failed = attempts.filter((attempt) => attempt.ok === false);
  return {
    count: attempts.length,
    failedCount: failed.length,
    failed: failed.slice(0, 3).map((attempt) => ({
      kind: attempt.kind,
      phase: attempt.phase,
      command: attempt.command,
      error: compactErrorMessage(attempt.error ?? "")
    }))
  };
}

function compactCompileTrigger(trigger) {
  return {
    ok: trigger.ok === true || trigger.fallback?.ok === true,
    source: trigger.ok === true ? trigger.source : trigger.fallback?.source ?? trigger.source,
    message: trigger.result?.message ?? trigger.fallback?.result?.message ?? null,
    errors: trigger.result?.numErrors ?? null,
    warnings: trigger.result?.numWarnings ?? null,
    fallbackUsed: trigger.ok !== true && Boolean(trigger.fallback)
  };
}

function compactDiagnosticsResult(result, mode, resourceUri) {
  if (mode === "tail") {
    return {
      ok: result.ok,
      logPath: result.logPath,
      filter: result.filter,
      totalLines: result.totalLines,
      matchedLines: result.matchedLines,
      startLine: result.startLine,
      lines: (result.lines ?? []).slice(-10),
      resourceUri
    };
  }

  return {
    ok: result.ok,
    logPath: result.logPath,
    inspectedFromLine: result.inspectedFromLine,
    totalLines: result.totalLines,
    diagnosticCount: result.diagnosticCount,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    latestSummary: result.latestSummary,
    summary: result.summary,
    diagnostics: result.diagnostics,
    resourceUri
  };
}

function compactActorProperty(property) {
  return {
    name: property.name,
    type: property.type ?? null,
    value: compactPreviewValue(property.value),
    writable: property.writable === true,
    source: property.source ?? "editor_property",
    ...(property.component ? { component: property.component } : {})
  };
}

function compactActorComponent(component) {
  const properties = component.properties ?? [];
  return {
    name: component.name,
    class: component.class,
    path: component.path ?? null,
    writable: component.writable === true,
    properties: properties.slice(0, 8).map(compactActorProperty),
    omittedProperties: Math.max(0, properties.length - 8)
  };
}

function compactActorUpdateChange(change) {
  return {
    index: change.index,
    path: change.path,
    op: change.op,
    before: compactPreviewValue(change.before),
    after: compactPreviewValue(change.after),
    setter: change.setter,
    writable: change.writable === true,
    source: change.source ?? null
  };
}

function compactPreviewValue(value) {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 297)}...` : value;
  }
  if (Array.isArray(value)) {
    if (value.length <= 12) {
      return value.map(compactPreviewValue);
    }
    return {
      kind: "array",
      length: value.length,
      preview: value.slice(0, 12).map(compactPreviewValue)
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length <= 8) {
      return Object.fromEntries(entries.map(([key, entryValue]) => [key, compactPreviewValue(entryValue)]));
    }
    return {
      kind: "object",
      keys: entries.slice(0, 8).map(([key]) => key),
      omittedKeys: Math.max(0, entries.length - 8)
    };
  }
  return value;
}

function compactErrorMessage(message) {
  const text = String(message ?? "").replace(/\r/g, "");
  const firstMeaningfulLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("Traceback") && !line.startsWith("File "));
  const line = firstMeaningfulLine ?? text.trim() ?? "Unknown error";
  const bridgeJsonMatch = line.match(/HTTP \d+:\s+({.+})$/);
  if (bridgeJsonMatch) {
    try {
      const parsed = JSON.parse(bridgeJsonMatch[1]);
      return compactErrorMessage(parsed.error ?? parsed.nextStep ?? line);
    } catch {
      // Keep the original line if the bridge body is not valid JSON.
    }
  }
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function shortNextStep(nextStep, fallbackMessage) {
  if (nextStep) {
    return compactErrorMessage(nextStep);
  }
  if (/not found|unknown/i.test(fallbackMessage ?? "")) {
    return "Check the identifier and use uefn_search or list resources before retrying.";
  }
  return "Check uefn_status and retry with narrower inputs if needed.";
}

function settledObject(result) {
  if (result.status === "fulfilled") {
    return result.value;
  }
  return {
    ok: false,
    error: result.reason?.message ?? String(result.reason)
  };
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
