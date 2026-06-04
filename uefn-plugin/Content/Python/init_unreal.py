try:
    import uefn_mcp_bridge

    uefn_mcp_bridge.register_menu()
except Exception as exc:
    try:
        import unreal

        unreal.log_error("UEFN MCP: failed to register menu: {}".format(exc))
    except Exception:
        print("UEFN MCP: failed to register menu: {}".format(exc))

