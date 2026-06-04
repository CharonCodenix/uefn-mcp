# UEFN MCP

Open source MCP server plus UEFN Python plugin bridge for AI-assisted Unreal Editor for Fortnite work.

This project is released for the community under the MIT license.

This is a very early version of the project. The goal is to keep scaling it alongside the UEFN ecosystem so it becomes increasingly useful for developers building on this platform.

## Installation Options

You have two good ways to install it:

1. Ask your preferred coding agent:

```text
Install the public UEFN MCP from https://github.com/CharonCodenix/uefn-mcp into my UEFN project at C:\Path\To\Fortnite Projects\YourProject.
```

Replace `C:\Path\To\Fortnite Projects\YourProject` with your real UEFN project folder.

2. Install it manually with the step-by-step guide below.

If Codex Desktop shows the MCP as enabled but the agent cannot see its tools, see [CODEX_MCP_TROUBLESHOOTING.md](CODEX_MCP_TROUBLESHOOTING.md). The usual fix is to fully restart Codex and confirm the MCP config points to the right local clone. Opening a new thread is usually not enough after changing MCP config.

## What It Provides

- A Node MCP server over stdio for Codex or another MCP client.
- A reusable UEFN Python plugin installed into `Content/Python/uefn_mcp_bridge`.
- A visible UEFN MCP launcher window with a `Start Bridge` button.
- Direct Verse compilation through UEFN's local Verse Workflow Server at `127.0.0.1:1962`.
- Scene context, actor inspection, actor updates, diagnostics, and viewport screenshots.
- UEFN Python execution with a required dry-run safety workflow.

## Prerequisites

- Windows machine with UEFN installed.
- Node.js 20 or newer.
- pnpm installed globally.
- A local UEFN project folder.
- Codex Desktop or another MCP-compatible client.

Install pnpm if you do not already have it:

```powershell
npm install -g pnpm
```

## Manual Installation

1. Clone the repo, then enter the cloned folder:

```powershell
git clone https://github.com/CharonCodenix/uefn-mcp.git
cd uefn-mcp
```

If you already cloned or downloaded the repo, open PowerShell inside that folder instead.

2. Set your project path once. Keep this PowerShell window open and run the rest of the commands in the same window:

```powershell
$ProjectPath = "C:\Path\To\Fortnite Projects\YourProject"
$RepoPath = (Get-Location).Path
```

3. Install dependencies:

```powershell
pnpm install
```

4. Copy the example config and write your project paths into it:

```powershell
Copy-Item .\uefn-mcp.config.example.json .\uefn-mcp.config.json
$Config = Get-Content .\uefn-mcp.config.json -Raw | ConvertFrom-Json
$Config.uefnProjectPath = $ProjectPath
$Config.contentPath = Join-Path $ProjectPath "Content"
$Config.uefnLogPath = Join-Path $env:LOCALAPPDATA "UnrealEditorFortnite\Saved\Logs\UnrealEditorFortnite.log"
$Config | ConvertTo-Json -Depth 10 | Set-Content .\uefn-mcp.config.json
```

5. Install the UEFN Python plugin into your target project:

```powershell
pnpm uefn:install -- --project "$ProjectPath"
```

What the installer does:

- Copies `uefn-plugin/Content/Python/uefn_mcp_bridge` into the UEFN project's `Content/Python`.
- Copies `start_uefn_mcp_bridge.py` into `Content/Python`.
- Inserts a managed block into `Content/Python/init_unreal.py`.
- Enables `pythonExperimental.bEnablePythonForProject` in the `.uefnproject`.
- Adds a native fallback recent script entry when UEFN preserves local recent scripts.

6. Add the MCP server to your Codex config.

On Windows, Codex config is usually here:

```text
%USERPROFILE%\.codex\config.toml
```

Build the block for your local clone:

```powershell
$ServerPath = Join-Path $RepoPath "src\server.mjs"
$CodexBlock = @"
[mcp_servers."uefn-mcp"]
command = "node"
args = ["$($ServerPath.Replace('\', '\\'))"]
cwd = "$($RepoPath.Replace('\', '\\'))"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
"@
$CodexBlock
```

Open your Codex config and paste the printed block:

```powershell
notepad "$env:USERPROFILE\.codex\config.toml"
```

The final block should look like this:

```toml
[mcp_servers."uefn-mcp"]
command = "node"
args = ["C:\\Path\\To\\uefn-mcp\\src\\server.mjs"]
cwd = "C:\\Path\\To\\uefn-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
```

7. Restart Codex. Opening a new thread is usually not enough after changing MCP config.

8. Open or restart UEFN and open your project.

9. In UEFN, click:

```text
UEFN MCP Bridge > Start Bridge
```

The launcher opens automatically from `Content/Python/init_unreal.py` when the project loads.

If the launcher is hidden, run this in UEFN's Python command line:

```python
import uefn_mcp_bridge; uefn_mcp_bridge.show_launcher_window()
```

If you need to start the bridge directly:

```python
import uefn_mcp_bridge; uefn_mcp_bridge.start_bridge_from_menu()
```

10. In your MCP client, ask for `uefn_status`. A healthy setup should show:

- Project detected.
- Python bridge reachable at `127.0.0.1:8765`.
- Verse Workflow Server reachable at `127.0.0.1:1962` when UEFN exposes it.

## Agent Installation Guide

If a user asks an agent to install this MCP, the agent should:

1. Clone the repository into a stable local folder.
2. Set `ProjectPath` to the exact UEFN project folder supplied by the user.
3. Run `pnpm install`.
4. Validate the user-supplied UEFN project folder has exactly one `.uefnproject`, a root `.uplugin`, and a `Content` directory.
5. Create `uefn-mcp.config.json` from the example using the user's project path.
6. Run:

```powershell
pnpm uefn:install -- --project "$ProjectPath"
```

7. Add the MCP block to the user's MCP client config with `command = "node"`, `args` pointing to `src/server.mjs`, and `cwd` pointing to the clone.
8. Ask the user to restart Codex/the MCP client and UEFN. For Codex, opening a new thread is usually not enough after changing MCP config.
9. Ask the user to click `UEFN MCP Bridge > Start Bridge`.
10. Verify with `uefn_status`.

Agents should not hardcode another user's project path, username, or machine-specific folder. Use the path supplied by the user.

## Uninstall

```powershell
pnpm uefn:uninstall -- --project "$ProjectPath"
```

This removes the managed Python package, launcher script, managed `init_unreal.py` block, and recent-script entry when present. It does not delete your UEFN project content.

## Security Notes

- The UEFN bridge listens on `127.0.0.1` only. It is intended for local editor automation, not public network access.
- The installer modifies only the target UEFN project you pass with `--project`: it copies the Python plugin, adds a managed `init_unreal.py` block, enables UEFN Python for the project, and may add a recent Python script entry.
- The uninstall command removes the managed plugin files and managed `init_unreal.py` block. It does not delete your island content.
- `uefn_run_python` uses a dry-run workflow. Scripts with warnings require an explicit `dryRunId` before execution, and execution requires the exact same script hash.
- Actor updates default to dry-run behavior unless the caller explicitly asks to apply changes.
- The MCP does not require API keys, tokens, cloud credentials, or external accounts.

## Main Tools

- `uefn_status`: project, bridge, and Verse workflow health.
- `uefn_project_summary`: compact project and Verse file summary.
- `uefn_search`: search Verse files or scene actors.
- `uefn_read_resource`: read a returned `uefn://...` resource URI.
- `uefn_scene_context`: compact scene snapshot via UEFN Python.
- `uefn_get_actor_details`: inspect an actor's transform, components, and editable fields.
- `uefn_update_actor`: dry-run or apply actor edits.
- `uefn_visual_context`: capture viewport or camera screenshot context.
- `uefn_compile_verse`: compile Verse via UEFN's Verse Workflow Server and parse logs.
- `uefn_diagnostics`: compact Verse diagnostics or log tail.
- `uefn_run_python`: dry-run first; clean dry-runs auto-execute.

## Useful Commands

Run validation:

```powershell
pnpm check
```

Run the MCP server manually:

```powershell
pnpm start
```

Dry-run plugin installation:

```powershell
pnpm uefn:install -- --project "$ProjectPath" --dry-run
```

## Python Safety Workflow

Python execution always starts with a dry-run. If the dry-run has no errors or warnings, the MCP executes the exact script automatically:

```json
{
  "mode": "dry_run",
  "script": "print('hello from UEFN')"
}
```

If the dry-run reports warnings, it does not execute. Review the warnings, then execute only the exact same script with the returned `dryRunId`.

## Configuration

The MCP reads local config from `uefn-mcp.config.json`. That file is intentionally ignored by Git because it contains machine-specific paths.

You can also use environment variables:

- `UEFN_PROJECT_PATH`
- `UEFN_CONTENT_PATH`
- `UEFN_BRIDGE_URL`
- `UEFN_VERSE_WORKFLOW_HOST`
- `UEFN_VERSE_WORKFLOW_PORT`
- `UEFN_LOG_PATH`
- `UEFN_MCP_RESOURCE_CACHE_DIR`
- `UEFN_MCP_ALLOW_PROJECT_PATH_OVERRIDE`
- `UEFN_MCP_ALLOW_EXTERNAL_LOG_PATH`

By default, ad hoc `projectPath` overrides are rejected. Validate a candidate folder first with `uefn_project_summary` and `validateOnly=true`, then explicitly enable overrides only if you need them.

## Resources

Large data is intentionally kept out of tool responses and exposed through resource URIs:

- `uefn://project/summary`
- `uefn://verse/file/{encodedRelativePath}`
- `uefn://scene/snapshot/{id}`
- `uefn://scene/actor-details/{id}`
- `uefn://scene/actor-updates/{id}`
- `uefn://visual/{id}.png`
- `uefn://logs/verse/{id}`
- `uefn://python/dry-run/{id}`

Recommended pattern:

```text
search -> inspect compact result -> read only the needed resource
```

## License

MIT. Use it, fork it, improve it, and share it.
