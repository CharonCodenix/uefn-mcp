# Codex MCP Troubleshooting Notes

## Codex Desktop shows the MCP enabled, but the agent cannot see the tools

Symptom:

```text
The MCP appears enabled in Codex Desktop, but the chat has no uefn_* tools.
```

First checks:

1. Confirm the config points to the local clone:

```toml
[mcp_servers."uefn-mcp"]
command = "node"
args = ["C:\\Path\\To\\uefn-mcp\\src\\server.mjs"]
cwd = "C:\\Path\\To\\uefn-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
```

2. Restart Codex Desktop or open a new thread after changing MCP config.

3. From the repo folder, run:

```powershell
pnpm check
```

4. Confirm dependencies are installed:

```powershell
pnpm install
```

Common cause:

Older hand-written MCP stdio transports can fail during the initial handshake. This project uses the official MCP SDK and `StdioServerTransport`, which is the recommended path for Codex compatibility.

If you see an error like this:

```text
MCP startup failed:
handshaking with MCP server failed:
connection closed: initialize response
serde error expected value at line 1 column 1
```

then the client is probably receiving non-JSON output before the MCP handshake completes. Check that:

- The configured `command` really starts `src/server.mjs`.
- No wrapper script prints banners or logs to stdout before the MCP server starts.
- The repo has current dependencies installed.
- You restarted the MCP client after changing config.

## UEFN bridge bootstrap port is already in use

Symptom:

```text
listen EADDRINUSE: address already in use 127.0.0.1:8766
```

This usually means a previous bootstrap server is still running. Check:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8766/health"
```

If it responds successfully, you can reuse the existing bootstrap server instead of starting another one.

## UEFN launcher window is missing

Try these in order:

1. Restart UEFN and reopen the project.
2. Reinstall the plugin:

```powershell
pnpm uefn:install -- --project "C:\Path\To\Fortnite Projects\YourProject"
```

3. Run this in UEFN's Python command line:

```python
import uefn_mcp_bridge; uefn_mcp_bridge.show_launcher_window()
```

4. Start the bridge directly:

```python
import uefn_mcp_bridge; uefn_mcp_bridge.start_bridge_from_menu()
```

## Checklist for future MCP changes

1. Use the official MCP SDK.
2. Keep MCP protocol traffic on stdout clean.
3. Send debug logs to stderr.
4. Test `initialize`.
5. Test `tools/list`.
6. Run `pnpm check`.
7. Open a new Codex thread after changing MCP configuration.
