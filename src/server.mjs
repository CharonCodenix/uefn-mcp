#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, SERVER_NAME, SERVER_VERSION } from "./lib/config.mjs";
import { ResourceStore, registerUefnResources } from "./lib/resource_store.mjs";
import { registerUefnTools } from "./lib/tools.mjs";

const config = await loadConfig();
const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});
const resourceStore = new ResourceStore(config);

registerUefnResources(server, config, resourceStore);
registerUefnTools(server, config, resourceStore);

await server.connect(new StdioServerTransport());

