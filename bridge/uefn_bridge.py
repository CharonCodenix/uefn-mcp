"""
Compatibility bootstrap for the reusable UEFN MCP Python plugin.

Preferred path: install uefn-plugin/Content/Python into a UEFN project and
click UEFN MCP > Start Bridge. This file remains for manual/bootstrap starts.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _candidate_python_roots():
    env_root = os.environ.get("UEFN_MCP_PLUGIN_PYTHON")
    if env_root:
        yield Path(env_root)

    if "__file__" in globals():
        yield Path(__file__).resolve().parents[1] / "uefn-plugin" / "Content" / "Python"


for root in _candidate_python_roots():
    if (root / "uefn_mcp_bridge" / "__init__.py").exists():
        sys.path.insert(0, str(root))
        break

import uefn_mcp_bridge  # noqa: E402


uefn_mcp_bridge.register_menu()
uefn_mcp_bridge.start_server()
