#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const serverPath = path.resolve(process.cwd(), "src", "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"]
});

const responses = new Map();
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.id !== undefined) {
    responses.set(message.id, message);
  }
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

send(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "uefn-mcp-smoke", version: "0.0.0" }
});
await waitForResponse(1);
sendNotification("notifications/initialized", {});
send(2, "tools/list", {});
const tools = await waitForResponse(2);
send(3, "resources/list", {});
const resources = await waitForResponse(3);
send(4, "tools/call", { name: "uefn_status", arguments: { detailLevel: "summary" } });
const status = await waitForResponse(4);

assertNoError(tools, "tools/list");
assertNoError(resources, "resources/list");
assertNoError(status, "tools/call uefn_status");

const toolNames = tools.result.tools.map((tool) => tool.name);
for (const expected of ["uefn_status", "uefn_compile_verse", "uefn_visual_context", "uefn_run_python", "uefn_get_actor_details", "uefn_update_actor"]) {
  if (!toolNames.includes(expected)) {
    throw new Error(`Missing expected tool ${expected}. Got: ${toolNames.join(", ")}`);
  }
}
if (toolNames.includes("uefn_apply_actor_changes")) {
  throw new Error("Deprecated tool uefn_apply_actor_changes should not be registered.");
}

if (!Array.isArray(resources.result.resources)) {
  throw new Error("resources/list did not return a resources array.");
}
if (!Array.isArray(status.result.content) || status.result.content.length === 0) {
  throw new Error("uefn_status did not return content.");
}

child.kill();
await once(child, "exit");
console.log(JSON.stringify({ ok: true, tools: toolNames.length, resources: resources.result.resources.length, status: "called" }));

function send(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function sendNotification(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function waitForResponse(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (responses.has(id)) {
      return responses.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited early with ${child.exitCode}. stderr: ${stderr}`);
    }
  }
  throw new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`);
}

function assertNoError(response, label) {
  if (response.error) {
    throw new Error(`${label} returned error: ${JSON.stringify(response.error)}`);
  }
}
