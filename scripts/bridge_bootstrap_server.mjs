#!/usr/bin/env node

import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const port = Number.parseInt(process.argv[2] ?? process.env.UEFN_BRIDGE_BOOTSTRAP_PORT ?? "8766", 10);
const bridgeScriptPath = path.resolve(process.cwd(), "bridge", "uefn_bridge.py");

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`Expected bootstrap port from 1024 to 65535, received: ${process.argv[2]}`);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8")
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "uefn_bridge_bootstrap",
        bridgeScriptPath
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/uefn_bridge.py") {
      const script = await fs.readFile(bridgeScriptPath, "utf8");
      response.writeHead(200, {
        "content-type": "text/x-python; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(script);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "Not found",
      nextStep: "Use /uefn_bridge.py as the bootstrap script URL."
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      nextStep: "Check that bridge/uefn_bridge.py exists and restart this bootstrap server."
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`UEFN bridge fallback bootstrap listening on http://127.0.0.1:${port}/uefn_bridge.py`);
  console.log("Preferred path: install the plugin and click UEFN MCP Bridge > Start Bridge.");
});
