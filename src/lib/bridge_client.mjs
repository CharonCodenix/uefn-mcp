import { normalizedBridgeUrl } from "./config.mjs";

export async function bridgeHealth(config, timeoutMs = 1500) {
  const url = new URL("/health", normalizedBridgeUrl(config));
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await readResponseBody(response);
    return {
      ok: response.ok && body?.ok !== false,
      bridgeUrl: normalizedBridgeUrl(config).replace(/\/$/, ""),
      status: response.status,
      body
    };
  } catch (error) {
    return {
      ok: false,
      bridgeUrl: normalizedBridgeUrl(config).replace(/\/$/, ""),
      error: error instanceof Error ? error.message : String(error),
      nextStep: "In UEFN, click the UEFN MCP Bridge launcher window's Start Bridge button, then retry uefn_status."
    };
  }
}

export async function bridgePost(config, toolName, body = {}, timeoutMs = 30000) {
  const url = new URL(`/tools/${toolName}`, normalizedBridgeUrl(config));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    const nextStep = responseBody?.nextStep ?? bridgeFailureNextStep(toolName, response.status);
    const error = new Error(`UEFN bridge ${toolName} failed with HTTP ${response.status}: ${JSON.stringify(responseBody)}. Next step: ${nextStep}`);
    error.bridgeTool = toolName;
    error.httpStatus = response.status;
    error.bridgeResponse = responseBody;
    error.nextStep = nextStep;
    throw error;
  }
  return responseBody;
}

export async function readResponseBody(response) {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bridgeFailureNextStep(toolName, status) {
  if (status === 404) {
    return "Update or restart the UEFN MCP bridge; this endpoint is not available in the running bridge.";
  }
  if (toolName === "visual_context") {
    return "Make sure UEFN is responsive, the level viewport exists, and retry with a lower width/height.";
  }
  if (toolName === "python_execute") {
    return "Run uefn_run_python with mode=dry_run first, then execute with the returned dryRunId.";
  }
  return "Check uefn_status, then restart the bridge from the UEFN MCP Bridge launcher if needed.";
}
