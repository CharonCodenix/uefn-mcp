from __future__ import annotations

import ast
import builtins
import contextlib
import hashlib
import io
import json
import os
import re
import time
import traceback
from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import urlparse

try:
    import unreal  # type: ignore
except Exception:
    unreal = None


HOST = "127.0.0.1"
PORT = 8765
VERSION = "0.3.0"
MAIN_THREAD_TIMEOUT_SECONDS = 30
RUNTIME_STATE_KEY = "_uefn_mcp_bridge_runtime_state"

_runtime_state = getattr(builtins, RUNTIME_STATE_KEY, None)
if _runtime_state is None:
    _runtime_state = {}
    setattr(builtins, RUNTIME_STATE_KEY, _runtime_state)

_runtime_state.setdefault("bridge_server", None)
_runtime_state.setdefault("bridge_thread", None)
_runtime_state.setdefault("launcher_thread", None)
_runtime_state.setdefault("launcher_root", None)
_runtime_state.setdefault("launcher_status", None)
_runtime_state.setdefault("launcher_lock", Lock())

_bridge_server = _runtime_state["bridge_server"]
_bridge_thread = _runtime_state["bridge_thread"]
_main_thread_jobs = deque()
_main_thread_jobs_lock = Lock()
_main_thread_callback_handle = None
_menu_registration_callback_handle = None
_menu_registration_attempts = 0
_menu_registration_next_retry_at = 0.0
_menu_registered = False
_menu_registered_targets = []
_menu_script_objects = []
_menu_script_class = None
_launcher_thread = _runtime_state["launcher_thread"]
_launcher_root = _runtime_state["launcher_root"]
_launcher_status = _runtime_state["launcher_status"]
_launcher_lock = _runtime_state["launcher_lock"]
_snapshots = {}
_dry_runs = {}

ACTOR_MATCH_BY_VALUES = {"label", "name", "path", "auto"}
TRANSFORM_PROPERTY_SUGGESTIONS = {
    "actorlocation": "transform.location",
    "location": "transform.location",
    "actorrotation": "transform.rotation",
    "rotation": "transform.rotation",
    "actorscale3d": "transform.scale",
    "scale3d": "transform.scale",
    "scale": "transform.scale",
}
ACTOR_PROPERTY_CANDIDATES = [
    "hidden",
    "can_be_damaged",
    "tags",
    "folder_path",
    "actor_guid",
    "root_component",
    "replicates",
    "net_dormancy",
    "net_cull_distance_squared",
    "initial_life_span",
    "auto_destroy_when_finished",
    "custom_time_dilation",
]
COMPONENT_PROPERTY_CANDIDATES = [
    "component_tags",
    "visible",
    "hidden_in_game",
    "mobility",
    "relative_location",
    "relative_rotation",
    "relative_scale3d",
    "can_ever_affect_navigation",
    "editable_when_inherited",
    "asset_user_data",
]


class ActorToolError(RuntimeError):
    def __init__(self, message, candidates=None, next_step=None):
        super().__init__(message)
        self.candidates = candidates or []
        self.next_step = next_step


def register_menu():
    _require_unreal()
    if not hasattr(unreal, "ToolMenus"):
        unreal.log_warning("UEFN MCP: ToolMenus is unavailable; run start_bridge_from_menu() from Python instead.")
        show_launcher_window()
        return False

    ok = _register_menu_entries()
    _schedule_menu_registration_retry()
    show_launcher_window()
    return ok


def _register_menu_entries():
    global _menu_registered, _menu_registered_targets

    menus = unreal.ToolMenus.get()
    owner = "UEFN_MCP"
    command = "import uefn_mcp_bridge; uefn_mcp_bridge.start_bridge_from_menu()"
    registered = []

    try:
        menus.unregister_owner_by_name(owner)
    except Exception:
        pass

    menu_targets = [
        "Valkyrie.LevelEditor.MainMenu.Tools",
        "Valkyrie.MainFrame.MainMenu.Tools",
        "Valkyrie.LevelEditor.MainMenu.Verse",
        "LevelEditor.MainMenu.Tools",
        "MainFrame.MainMenu.Tools",
        "LevelEditor.MainMenu.Window",
        "MainFrame.MainMenu.Window",
    ]
    toolbar_targets = [
        "Valkyrie.LevelEditor.LevelEditorToolBar.AssetsToolBar",
        "Valkyrie.LevelEditor.LevelEditorToolBar.PlayToolBar",
        "Valkyrie.LevelEditor.StatusBar.ToolBar",
        "LevelEditor.LevelEditorToolBar.AssetsToolBar",
        "LevelEditor.LevelEditorToolBar.User",
        "LevelEditor.StatusBar.ToolBar",
    ]
    main_menu_targets = [
        "Valkyrie.LevelEditor.MainMenu",
        "LevelEditor.MainMenu",
        "MainFrame.MainMenu",
    ]

    for menu_name in menu_targets:
        if _add_start_bridge_menu_entry(menus, menu_name, command, owner):
            registered.append(menu_name)

    for toolbar_name in toolbar_targets:
        if _add_start_bridge_toolbar_button(menus, toolbar_name, command, owner):
            registered.append(toolbar_name)

    for menu_name in main_menu_targets:
        if _add_start_bridge_submenu(menus, menu_name, command, owner):
            registered.append(menu_name)

    try:
        menus.refresh_all_widgets()
    except Exception:
        pass
    for menu_name in registered:
        try:
            menus.refresh_menu_widget(menu_name)
        except Exception:
            pass

    if registered:
        _menu_registered = True
        _menu_registered_targets = registered
        unreal.log("UEFN MCP: registered Start Bridge menu entries in {}.".format(", ".join(registered)))
        return True

    _menu_registered = False
    _menu_registered_targets = []
    unreal.log_error("UEFN MCP: could not register any ToolMenus entry. Run this in the Python console: {}".format(command))
    return False


def _add_start_bridge_menu_entry(menus, menu_name, command, owner):
    menu = menus.find_menu(menu_name)
    if not menu:
        return False
    entry_name = "UEFN_MCP_StartBridge_" + menu_name.replace(".", "_")

    try:
        menu.add_section(owner, "UEFN MCP")
    except Exception:
        pass

    script_object = _make_start_bridge_script_object(
        menu_name,
        owner,
        owner,
        entry_name,
        "UEFN MCP: Start Bridge",
        "Start the local UEFN MCP bridge on 127.0.0.1:8765",
        unreal.MultiBlockType.MENU_ENTRY,
    )
    if script_object is not None:
        menu.add_menu_entry_object(script_object)
        return True

    entry = unreal.ToolMenuEntry(
        name=entry_name,
        type=unreal.MultiBlockType.MENU_ENTRY,
        user_interface_action_type=unreal.UserInterfaceActionType.BUTTON,
        insert_position=unreal.ToolMenuInsert("", unreal.ToolMenuInsertType.FIRST),
    )
    entry.set_label("UEFN MCP: Start Bridge")
    entry.set_tool_tip("Start the local UEFN MCP bridge on 127.0.0.1:8765")
    entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", command)
    menu.add_menu_entry(owner, entry)
    return True


def _add_start_bridge_toolbar_button(menus, menu_name, command, owner):
    menu = menus.find_menu(menu_name)
    if not menu:
        return False
    entry_name = "UEFN_MCP_StartBridge_" + menu_name.replace(".", "_")

    try:
        menu.add_section(owner, "UEFN MCP")
    except Exception:
        pass

    script_object = _make_start_bridge_script_object(
        menu_name,
        owner,
        owner,
        entry_name,
        "UEFN MCP",
        "Start the local UEFN MCP bridge on 127.0.0.1:8765",
        unreal.MultiBlockType.TOOL_BAR_BUTTON,
    )
    if script_object is not None:
        menu.add_menu_entry_object(script_object)
        return True

    entry = unreal.ToolMenuEntry(
        name=entry_name,
        type=unreal.MultiBlockType.TOOL_BAR_BUTTON,
        user_interface_action_type=unreal.UserInterfaceActionType.BUTTON,
        insert_position=unreal.ToolMenuInsert("", unreal.ToolMenuInsertType.LAST),
    )
    entry.set_label("UEFN MCP")
    entry.set_tool_tip("Start the local UEFN MCP bridge on 127.0.0.1:8765")
    entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", command)

    menu.add_menu_entry(owner, entry)
    return True


def _add_start_bridge_submenu(menus, menu_name, command, owner):
    menu = menus.find_menu(menu_name)
    if not menu:
        return False
    try:
        submenu = menu.add_sub_menu(owner, owner, "UEFN_MCP_Menu", "UEFN MCP", "UEFN MCP bridge tools")
        submenu_name = "{}.UEFN_MCP_Menu".format(menu_name)
        entry_name = "UEFN_MCP_StartBridge_Submenu_" + menu_name.replace(".", "_")
        script_object = _make_start_bridge_script_object(
            submenu_name,
            owner,
            owner,
            entry_name,
            "Start Bridge",
            "Start the local UEFN MCP bridge on 127.0.0.1:8765",
            unreal.MultiBlockType.MENU_ENTRY,
        )
        if script_object is not None:
            submenu.add_menu_entry_object(script_object)
        else:
            entry = unreal.ToolMenuEntry(
                name=entry_name,
                type=unreal.MultiBlockType.MENU_ENTRY,
                user_interface_action_type=unreal.UserInterfaceActionType.BUTTON,
            )
            entry.set_label("Start Bridge")
            entry.set_tool_tip("Start the local UEFN MCP bridge on 127.0.0.1:8765")
            entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", command)
            submenu.add_menu_entry(owner, entry)
        return True
    except Exception as exc:
        unreal.log_warning("UEFN MCP: failed to add submenu in {}: {}".format(menu_name, exc))
        return False


def _make_start_bridge_script_object(menu, section, owner, name, label, tool_tip, entry_type):
    global _menu_script_class

    if not hasattr(unreal, "ToolMenuEntryScript"):
        return None
    if _menu_script_class is None:
        try:
            @unreal.uclass()
            class UEFNMCPStartBridgeMenuEntry(unreal.ToolMenuEntryScript):
                def __init__(self, menu, section, owner, name, label, tool_tip, entry_type):
                    super().__init__()
                    self.init_entry(
                        owner_name=owner,
                        menu=menu,
                        section=section,
                        name=name,
                        label=label,
                        tool_tip=tool_tip,
                    )
                    self._uefn_mcp_label = label
                    self._uefn_mcp_tool_tip = tool_tip
                    self._uefn_mcp_entry_type = entry_type
                    try:
                        data = self.get_editor_property("data")
                        advanced = data.get_editor_property("advanced")
                        advanced.set_editor_property("entry_type", entry_type)
                        advanced.set_editor_property("user_interface_action_type", unreal.UserInterfaceActionType.BUTTON)
                        data.set_editor_property("advanced", advanced)
                    except Exception:
                        pass

                @unreal.ufunction(override=True)
                def execute(self, context):
                    import uefn_mcp_bridge
                    uefn_mcp_bridge.start_bridge_from_menu()

                @unreal.ufunction(override=True)
                def can_execute(self, context):
                    return True

                @unreal.ufunction(override=True)
                def get_label(self, context):
                    return self._uefn_mcp_label

                @unreal.ufunction(override=True)
                def get_tool_tip(self, context):
                    return self._uefn_mcp_tool_tip

                @unreal.ufunction(override=True)
                def show_in_toolbar_top_level(self, context):
                    return True

            _menu_script_class = UEFNMCPStartBridgeMenuEntry
        except Exception as exc:
            unreal.log_warning("UEFN MCP: ToolMenuEntryScript unavailable, using Python string command: {}".format(exc))
            _menu_script_class = False
    if not _menu_script_class:
        return None

    try:
        script_object = _menu_script_class(menu, section, owner, name, label, tool_tip, entry_type)
    except Exception as exc:
        unreal.log_warning("UEFN MCP: failed to create ToolMenuEntryScript, using Python string command: {}".format(exc))
        return None
    _menu_script_objects.append(script_object)
    return script_object


def _schedule_menu_registration_retry():
    global _menu_registration_callback_handle, _menu_registration_attempts, _menu_registration_next_retry_at

    if not hasattr(unreal, "register_slate_post_tick_callback"):
        return
    if _menu_registration_callback_handle is not None:
        return
    _menu_registration_attempts = 0
    _menu_registration_next_retry_at = time.monotonic() + 0.75
    _menu_registration_callback_handle = unreal.register_slate_post_tick_callback(_retry_menu_registration_on_tick)


def _retry_menu_registration_on_tick(delta_seconds):
    global _menu_registration_callback_handle, _menu_registration_attempts, _menu_registration_next_retry_at

    now = time.monotonic()
    if now < _menu_registration_next_retry_at:
        return

    _menu_registration_attempts += 1
    _menu_registration_next_retry_at = now + 0.75
    try:
        _register_menu_entries()
    except Exception as exc:
        unreal.log_warning("UEFN MCP: deferred menu registration attempt failed: {}".format(exc))

    if _menu_registration_attempts >= 8 and _menu_registration_callback_handle is not None:
        try:
            unreal.unregister_slate_post_tick_callback(_menu_registration_callback_handle)
        except Exception:
            pass
        _menu_registration_callback_handle = None


def start_bridge_from_menu(host=HOST, port=PORT):
    server = start_server(host, port)
    if unreal is not None:
        unreal.log("UEFN MCP: bridge ready at http://{}:{}".format(host, port))
    _set_launcher_status("Bridge running at {}:{}".format(host, port))
    return server


def show_launcher_window():
    global _launcher_thread

    _require_unreal()
    with _launcher_lock:
        _launcher_thread = _runtime_state.get("launcher_thread")
        if _launcher_thread is not None and _launcher_thread.is_alive():
            _set_launcher_status(_bridge_status_text())
            _show_existing_launcher_window()
            return True

        try:
            unreal.EditorPythonScripting.set_keep_python_script_alive(True)
        except Exception:
            pass

        _launcher_thread = Thread(target=_run_launcher_window, name="uefn-mcp-launcher", daemon=True)
        _runtime_state["launcher_thread"] = _launcher_thread
        _launcher_thread.start()
        return True


def _run_launcher_window():
    global _launcher_root, _launcher_status

    try:
        import tkinter as tk
        from tkinter import ttk
    except Exception as exc:
        if unreal is not None:
            unreal.log_warning("UEFN MCP: tkinter launcher unavailable: {}".format(exc))
        return

    try:
        root = tk.Tk()
        root.title("UEFN MCP Bridge")
        root.geometry("340x150+48+140")
        root.resizable(False, False)
        root.attributes("-topmost", True)
        root.configure(bg="#202124")
        root.after(1200, lambda: _set_launcher_topmost(root, False))

        style = ttk.Style(root)
        with contextlib.suppress(Exception):
            style.theme_use("clam")
        style.configure("UEFNMCP.TFrame", background="#202124")
        style.configure("UEFNMCP.TLabel", background="#202124", foreground="#f1f3f4", font=("Segoe UI", 10))
        style.configure("UEFNMCP.Title.TLabel", background="#202124", foreground="#ffffff", font=("Segoe UI", 12, "bold"))
        style.configure("UEFNMCP.TButton", font=("Segoe UI", 10, "bold"), padding=(12, 6))

        frame = ttk.Frame(root, padding=14, style="UEFNMCP.TFrame")
        frame.pack(fill="both", expand=True)

        title = ttk.Label(frame, text="UEFN MCP Bridge", style="UEFNMCP.Title.TLabel")
        title.pack(anchor="w")

        status_text = tk.StringVar(value=_bridge_status_text())
        _launcher_status = status_text
        _runtime_state["launcher_status"] = status_text
        status = ttk.Label(frame, textvariable=status_text, style="UEFNMCP.TLabel")
        status.pack(anchor="w", pady=(6, 12))

        buttons = ttk.Frame(frame, style="UEFNMCP.TFrame")
        buttons.pack(fill="x")

        start_button = ttk.Button(
            buttons,
            text="Start Bridge",
            style="UEFNMCP.TButton",
            command=lambda: _launcher_start_bridge(status_text),
        )
        start_button.pack(side="left")

        close_button = ttk.Button(buttons, text="Hide", command=root.withdraw)
        close_button.pack(side="right")

        _launcher_root = root
        _runtime_state["launcher_root"] = root
        root.protocol("WM_DELETE_WINDOW", root.withdraw)
        root.after(1000, lambda: _launcher_refresh_status(root, status_text))
        root.mainloop()
    except Exception as exc:
        if unreal is not None:
            unreal.log_warning("UEFN MCP: launcher window failed: {}".format(exc))
    finally:
        with _launcher_lock:
            if _runtime_state.get("launcher_root") is _launcher_root:
                _runtime_state["launcher_root"] = None
            if _runtime_state.get("launcher_status") is _launcher_status:
                _runtime_state["launcher_status"] = None
            if _runtime_state.get("launcher_thread") is _launcher_thread:
                _runtime_state["launcher_thread"] = None
            _launcher_root = None
            _launcher_status = None


def _show_existing_launcher_window():
    root = _runtime_state.get("launcher_root") or _launcher_root
    if root is None:
        return
    try:
        root.after(0, lambda: _raise_launcher_window(root))
    except Exception:
        pass


def _raise_launcher_window(root):
    try:
        root.deiconify()
        root.lift()
        root.attributes("-topmost", True)
        root.after(1200, lambda: _set_launcher_topmost(root, False))
    except Exception:
        pass


def _set_launcher_topmost(root, value):
    try:
        root.attributes("-topmost", value)
    except Exception:
        pass


def _launcher_start_bridge(status_text):
    try:
        start_bridge_from_menu()
        status_text.set(_bridge_status_text())
    except Exception as exc:
        message = "Error: {}".format(exc)
        status_text.set(message)
        if unreal is not None:
            unreal.log_error("UEFN MCP: launcher could not start bridge: {}".format(exc))


def _launcher_refresh_status(root, status_text):
    try:
        status_text.set(_bridge_status_text())
    except Exception:
        pass
    try:
        root.after(1000, lambda: _launcher_refresh_status(root, status_text))
    except Exception:
        pass


def _bridge_status_text():
    if (_runtime_state.get("bridge_server") or _bridge_server) is None:
        return "Bridge stopped"
    return "Bridge running at {}:{}".format(HOST, PORT)


def _set_launcher_status(value):
    status = _runtime_state.get("launcher_status") or _launcher_status
    root = _runtime_state.get("launcher_root") or _launcher_root
    if status is None:
        return
    try:
        if root is not None:
            root.after(0, lambda: status.set(value))
        else:
            status.set(value)
    except Exception:
        pass


def start_server(host=HOST, port=PORT):
    global _bridge_server, _bridge_thread
    _require_unreal()

    _bridge_server = _runtime_state.get("bridge_server")
    _bridge_thread = _runtime_state.get("bridge_thread")
    if _bridge_server is not None:
        return _bridge_server

    try:
        unreal.EditorPythonScripting.set_keep_python_script_alive(True)
    except Exception:
        pass

    try:
        _bridge_server = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 10048 or getattr(exc, "errno", None) in (48, 98):
            if unreal is not None:
                unreal.log("UEFN MCP: bridge already appears to be listening at http://{}:{}.".format(host, port))
            _set_launcher_status("Bridge already listening at {}:{}".format(host, port))
            return _bridge_server
        raise

    _bridge_thread = Thread(target=_bridge_server.serve_forever, name="uefn-mcp-bridge", daemon=True)
    _bridge_thread.start()
    _runtime_state["bridge_server"] = _bridge_server
    _runtime_state["bridge_thread"] = _bridge_thread
    return _bridge_server


def stop_server():
    global _bridge_server, _bridge_thread
    _bridge_server = _runtime_state.get("bridge_server")
    _bridge_thread = _runtime_state.get("bridge_thread")
    if _bridge_server is not None:
        _bridge_server.shutdown()
        _bridge_server.server_close()
    _bridge_server = None
    _bridge_thread = None
    _runtime_state["bridge_server"] = None
    _runtime_state["bridge_thread"] = None
    _set_launcher_status("Bridge stopped")
    return {"ok": True}


def _require_unreal():
    if unreal is None:
        raise RuntimeError("The unreal Python module is unavailable. Run this script inside UEFN.")


def _editor_actor_subsystem():
    _require_unreal()
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def _process_main_thread_jobs(delta_seconds):
    global _main_thread_callback_handle

    while True:
        with _main_thread_jobs_lock:
            if not _main_thread_jobs:
                if _main_thread_callback_handle is not None:
                    try:
                        unreal.unregister_slate_post_tick_callback(_main_thread_callback_handle)
                    except Exception:
                        pass
                    _main_thread_callback_handle = None
                return
            job = _main_thread_jobs.popleft()

        try:
            result = job["func"](job["args"])
            if isinstance(result, dict):
                result = dict(result)
                result["executionThread"] = {
                    "requested": "editor_main_thread",
                    "actual": "editor_main_thread",
                    "scheduler": "register_slate_post_tick_callback",
                }
            job["result"] = result
        except Exception as exc:
            job["error"] = exc
            job["traceback"] = traceback.format_exc()
        finally:
            job["event"].set()


def _ensure_main_thread_callback_locked():
    global _main_thread_callback_handle
    if _main_thread_callback_handle is not None:
        return
    if not hasattr(unreal, "register_slate_post_tick_callback"):
        raise RuntimeError("UEFN Python does not expose register_slate_post_tick_callback.")
    _main_thread_callback_handle = unreal.register_slate_post_tick_callback(_process_main_thread_jobs)


def _run_on_editor_main_thread(tool_name, func, args, timeout_seconds=MAIN_THREAD_TIMEOUT_SECONDS):
    _require_unreal()
    job = {
        "toolName": tool_name,
        "func": func,
        "args": args,
        "event": Event(),
        "result": None,
        "error": None,
        "traceback": None,
    }

    with _main_thread_jobs_lock:
        _ensure_main_thread_callback_locked()
        _main_thread_jobs.append(job)

    if not job["event"].wait(timeout_seconds):
        raise RuntimeError("{} timed out waiting for UEFN editor main thread.".format(tool_name))
    if job["error"] is not None:
        raise RuntimeError("{} failed on UEFN editor main thread: {}\n{}".format(
            tool_name,
            job["error"],
            job["traceback"],
        ))
    return job["result"]


def _all_actors():
    return list(_editor_actor_subsystem().get_all_level_actors())


def _selected_actors():
    return list(_editor_actor_subsystem().get_selected_level_actors())


def _actor_label(actor):
    try:
        return actor.get_actor_label()
    except Exception:
        return actor.get_name()


def _actor_folder(actor):
    try:
        return str(actor.get_folder_path())
    except Exception:
        return ""


def _actor_class(actor):
    try:
        return actor.get_class().get_name()
    except Exception:
        return type(actor).__name__


def _actor_path(actor):
    try:
        return actor.get_path_name()
    except Exception:
        return actor.get_name()


def _object_name(value):
    try:
        return value.get_name()
    except Exception:
        return type(value).__name__


def _object_class(value):
    try:
        return value.get_class().get_name()
    except Exception:
        return type(value).__name__


def _object_path(value):
    try:
        return value.get_path_name()
    except Exception:
        return _object_name(value)


def _clean_number(value):
    number = float(value)
    rounded = round(number, 6)
    if abs(rounded - round(rounded)) < 0.000001:
        return int(round(rounded))
    return rounded


def _vector_to_list(value):
    return [_clean_number(value.x), _clean_number(value.y), _clean_number(value.z)]


def _rotator_to_list(value):
    return [_clean_number(value.roll), _clean_number(value.pitch), _clean_number(value.yaw)]


def _make_vector(values):
    _require_unreal()
    return unreal.Vector(float(values[0]), float(values[1]), float(values[2]))


def _make_rotator(values):
    _require_unreal()
    roll, pitch, yaw = values
    return unreal.Rotator(float(pitch), float(yaw), float(roll))


def _is_vector_like(value):
    return hasattr(value, "x") and hasattr(value, "y") and hasattr(value, "z")


def _is_rotator_like(value):
    return hasattr(value, "roll") and hasattr(value, "pitch") and hasattr(value, "yaw")


def _actor_transform(actor):
    try:
        location = actor.get_actor_location()
        rotation = actor.get_actor_rotation()
        scale = actor.get_actor_scale3d()
        return {
            "location": _vector_to_list(location),
            "rotation": _rotator_to_list(rotation),
            "scale": _vector_to_list(scale),
            "writable": all(hasattr(actor, method) for method in [
                "set_actor_location",
                "set_actor_rotation",
                "set_actor_scale3d",
            ]),
        }
    except Exception:
        return None


def _actor_to_dict(actor, detail_level="summary"):
    data = {
        "name": actor.get_name(),
        "label": _actor_label(actor),
        "class": _actor_class(actor),
        "folder": _actor_folder(actor),
        "path": _actor_path(actor),
    }
    if detail_level == "detail":
        data["transform"] = _actor_transform(actor)
    return data


def _actor_key_values(actor_dict):
    return [
        str(actor_dict.get("name", "")),
        str(actor_dict.get("label", "")),
        str(actor_dict.get("path", "")),
    ]


def _actor_importance_score(actor_dict, selected_keys=None):
    selected_keys = selected_keys or set()
    name = str(actor_dict.get("name", "")).lower()
    label = str(actor_dict.get("label", "")).lower()
    class_name = str(actor_dict.get("class", "")).lower()
    folder = str(actor_dict.get("folder", "")).lower().replace("\\", "/")
    text = "{} {} {} {}".format(name, label, class_name, folder)
    score = 1000

    if any(value and value in selected_keys for value in _actor_key_values(actor_dict)):
        score -= 1000

    if "versedevice" in class_name or "verse device" in text:
        score -= 650
    if class_name.startswith("device_") or "_device" in class_name or "device_" in class_name:
        score -= 520
    if "customcreativedevices" in folder or "custom creative devices" in folder:
        score -= 320

    important_terms = [
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
        "activador",
    ]
    if any(term in text for term in important_terms):
        score -= 220

    generic_terms = [
        "worlddatalayers",
        "staticmeshactor",
        "fortstaticmeshactor",
        "basic_tile",
        "basictile",
        "floors_generic",
        "cuadrosx",
        "test",
        "prototype",
    ]
    if any(term in text for term in generic_terms):
        score += 450

    return score


def _sort_actor_dicts_for_context(actor_dicts):
    selected_keys = set()
    try:
        for actor in _selected_actors():
            selected_dict = _actor_to_dict(actor)
            selected_keys.update(value for value in _actor_key_values(selected_dict) if value)
    except Exception:
        selected_keys = set()

    indexed = list(enumerate(actor_dicts))
    indexed.sort(key=lambda item: (
        _actor_importance_score(item[1], selected_keys),
        str(item[1].get("folder", "")).lower(),
        str(item[1].get("label", "")).lower(),
        str(item[1].get("name", "")).lower(),
        item[0],
    ))
    return [actor_dict for _, actor_dict in indexed]


def _matches_folder(actor, folder):
    if not folder:
        return True
    expected = str(folder).replace("\\", "/").strip("/").lower()
    actual = _actor_folder(actor).replace("\\", "/").strip("/").lower()
    return actual == expected or actual.endswith("/" + expected) or expected in actual


def _actor_matches_identifier(actor, identifier, match_by):
    if match_by == "label":
        return _actor_label(actor) == identifier
    if match_by == "name":
        return actor.get_name() == identifier
    if match_by == "path":
        return _actor_path(actor) == identifier
    return actor.get_name() == identifier or _actor_label(actor) == identifier or _actor_path(actor) == identifier


def _resolve_actor(identifier, match_by="label", folder=None):
    identifier = str(identifier or "")
    match_by = str(match_by or "label").lower()
    if not identifier:
        return {
            "ok": False,
            "error": "Actor identifier is required.",
            "candidates": [],
            "nextStep": "Pass actor with an exact label, name, or path.",
        }
    if match_by not in ACTOR_MATCH_BY_VALUES:
        return {
            "ok": False,
            "error": "Unsupported matchBy value: {}".format(match_by),
            "candidates": [],
            "nextStep": "Use matchBy label, name, path, or auto.",
        }

    matches = []
    for actor in _all_actors():
        if not _matches_folder(actor, folder):
            continue
        if _actor_matches_identifier(actor, identifier, match_by):
            matches.append(actor)

    if len(matches) == 1:
        return {"ok": True, "actor": matches[0]}
    if len(matches) == 0:
        return {
            "ok": False,
            "error": "Actor not found: {} using matchBy={}.".format(identifier, match_by),
            "candidates": [],
            "nextStep": "Use uefn_search or uefn_scene_context to find the exact actor label, name, or path.",
        }
    return {
        "ok": False,
        "error": "Actor identifier is ambiguous: {} using matchBy={}.".format(identifier, match_by),
        "candidates": [_actor_to_dict(actor, "summary") for actor in matches[:20]],
        "nextStep": "Retry with matchBy=name or matchBy=path using one of the returned candidates.",
    }


def _actor_resolution_failure(result):
    return {
        "ok": False,
        "error": result.get("error"),
        "candidates": result.get("candidates", []),
        "nextStep": result.get("nextStep"),
    }


def _find_actor(name, folder=None):
    result = _resolve_actor(name, "auto", folder)
    if result.get("ok"):
        return result["actor"]
    raise RuntimeError(result.get("error") or "Actor not found: {}".format(name))


def _jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if _is_rotator_like(value):
        return _rotator_to_list(value)
    if _is_vector_like(value):
        return _vector_to_list(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if hasattr(value, "get_actor_label") or hasattr(value, "get_actor_location"):
        return _actor_to_dict(value)
    if hasattr(value, "get_name"):
        return {
            "name": _object_name(value),
            "class": _object_class(value),
            "path": _object_path(value),
        }
    return str(value)


def _value_type_name(value):
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int) and not isinstance(value, bool):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if _is_vector_like(value):
        return "Vector"
    if _is_rotator_like(value):
        return "Rotator"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, dict):
        return "object"
    if hasattr(value, "get_class"):
        return _object_class(value)
    return type(value).__name__


def _filter_tokens(filter_text):
    if not filter_text:
        return []
    return [token for token in re.split(r"[\s,|]+", str(filter_text)) if token]


def _compile_filter(filter_text):
    if not filter_text:
        return None
    try:
        return re.compile(str(filter_text), re.IGNORECASE)
    except re.error:
        return str(filter_text).lower()


def _matches_filter(compiled_filter, *values):
    if not compiled_filter:
        return True
    text = " ".join(str(value) for value in values if value is not None)
    if hasattr(compiled_filter, "search"):
        return bool(compiled_filter.search(text))
    return str(compiled_filter) in text.lower()


def _dedupe_names(names):
    seen = set()
    result = []
    for name in names:
        text = str(name or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _editor_property_names(obj, fallback_names=None, filter_text=None):
    names = []
    for method_name in ["get_editor_property_names", "get_property_names"]:
        try:
            method = getattr(obj, method_name)
            for name in method():
                names.append(str(name))
        except Exception:
            pass
    try:
        cls = obj.get_class()
        for method_name in ["get_properties", "properties"]:
            try:
                method = getattr(cls, method_name)
                for prop in method():
                    if hasattr(prop, "get_name"):
                        names.append(str(prop.get_name()))
                    elif hasattr(prop, "name"):
                        names.append(str(prop.name))
                    else:
                        names.append(str(prop))
            except Exception:
                pass
    except Exception:
        pass
    names.extend(fallback_names or [])
    names.extend(_filter_tokens(filter_text))
    return _dedupe_names(names)


def _editor_properties_for_object(obj, source, detail_level="summary", filter_text=None, fallback_names=None, component_name=None):
    compiled_filter = _compile_filter(filter_text)
    properties = []
    max_properties = 100 if detail_level == "detail" else 30
    for name in _editor_property_names(obj, fallback_names, filter_text):
        if not _matches_filter(compiled_filter, name):
            continue
        try:
            value = obj.get_editor_property(name)
        except Exception:
            continue
        entry = {
            "name": name,
            "type": _value_type_name(value),
            "value": _jsonable(value),
            "writable": hasattr(obj, "set_editor_property"),
            "source": source,
        }
        if component_name:
            entry["component"] = component_name
        properties.append(entry)
        if len(properties) >= max_properties:
            break
    return properties


def _actor_components(actor):
    components = []
    try:
        components = list(actor.get_components_by_class(unreal.ActorComponent))
    except Exception:
        try:
            components = list(actor.get_components())
        except Exception:
            components = []
    return components


def _component_to_dict(component, detail_level="summary", include_properties=False, filter_text=None):
    data = {
        "name": _object_name(component),
        "class": _object_class(component),
        "path": _object_path(component),
        "writable": hasattr(component, "set_editor_property"),
    }
    if include_properties:
        data["properties"] = _editor_properties_for_object(
            component,
            "component_editor_property",
            detail_level,
            filter_text,
            COMPONENT_PROPERTY_CANDIDATES,
            component_name=data["name"],
        )
    return data


def list_actors(args):
    folder = args.get("folder")
    name_contains = str(args.get("nameContains", "")).lower()
    class_contains = str(args.get("classContains", "")).lower()
    limit = int(args.get("limit", 200))
    detail_level = args.get("detailLevel", "summary")
    actors = []

    for actor in _all_actors():
        actor_dict = _actor_to_dict(actor, detail_level)
        label_name = "{} {}".format(actor_dict["label"], actor_dict["name"]).lower()
        class_name = actor_dict["class"].lower()
        if folder and not _matches_folder(actor, folder):
            continue
        if name_contains and name_contains not in label_name:
            continue
        if class_contains and class_contains not in class_name:
            continue
        actors.append(actor_dict)

    sorted_actors = _sort_actor_dicts_for_context(actors)
    limited_actors = sorted_actors[:limit]
    return {
        "ok": True,
        "count": len(limited_actors),
        "totalMatches": len(sorted_actors),
        "ranking": "selected > Verse devices > UEFN devices > CustomCreativeDevices/important gameplay names > generic meshes",
        "actors": limited_actors,
    }


def scene_context_issue(args):
    detail_level = args.get("detailLevel", "summary")
    actor_result = list_actors(args)
    selected = [_actor_to_dict(actor, detail_level) for actor in _selected_actors()] if args.get("includeSelection", True) else []
    class_counts = Counter(actor["class"] for actor in actor_result["actors"])
    folder_counts = Counter(actor["folder"] for actor in actor_result["actors"])
    snapshot_id = "scene_{}_{}".format(int(time.time()), hashlib.sha1(os.urandom(16)).hexdigest()[:8])
    snapshot = {
        "ok": True,
        "snapshotId": snapshot_id,
        "summary": {
            "returnedActors": len(actor_result["actors"]),
            "selectedActors": len(selected),
            "topClasses": class_counts.most_common(12),
            "topFolders": folder_counts.most_common(12),
        },
        "actors": actor_result["actors"],
        "selection": selected,
    }
    _snapshots[snapshot_id] = snapshot
    return snapshot


def scene_context(args):
    return _run_on_editor_main_thread("scene_context", scene_context_issue, args)


def actor_details_on_main_thread(args):
    result = _resolve_actor(args.get("actor"), args.get("matchBy", "label"))
    if not result.get("ok"):
        return _actor_resolution_failure(result)

    actor = result["actor"]
    detail_level = args.get("detailLevel", "summary")
    filter_text = args.get("filter")
    include_properties = bool(args.get("includeProperties", False)) or bool(filter_text)
    include_components = args.get("includeComponents", True) is not False
    warnings = []

    properties = []
    if include_properties:
        properties = _editor_properties_for_object(
            actor,
            "editor_property",
            detail_level,
            filter_text,
            ACTOR_PROPERTY_CANDIDATES,
        )
        if filter_text and not properties:
            warnings.append("No readable actor editor properties matched filter '{}'.".format(filter_text))

    components = []
    if include_components:
        for component in _actor_components(actor):
            components.append(_component_to_dict(
                component,
                detail_level,
                include_properties=include_properties,
                filter_text=filter_text,
            ))

    return {
        "ok": True,
        "actor": _actor_to_dict(actor, "summary"),
        "transform": _actor_transform(actor),
        "properties": properties,
        "components": components,
        "propertyCount": len(properties),
        "componentCount": len(components),
        "warnings": sorted(set(warnings)),
    }


def actor_details(args):
    return _run_on_editor_main_thread("actor_details", actor_details_on_main_thread, args)


def _normalize_property_key(name):
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def _reject_transform_property_alias(prop):
    suggestion = TRANSFORM_PROPERTY_SUGGESTIONS.get(_normalize_property_key(prop))
    if suggestion:
        raise ActorToolError(
            "{} is not a writable editor property path. Use {} instead.".format(prop, suggestion),
            next_step="Use transform paths for actor location, rotation, and scale so the bridge can call the correct actor setter.",
        )


def _parse_actor_update_path(path):
    text = str(path or "").strip()
    if not text:
        raise ActorToolError("Operation path is required.")

    lower = text.lower()
    if lower == "label":
        return {"kind": "label", "path": text}

    if lower.startswith("transform."):
        parts = lower.split(".")
        if len(parts) not in (2, 3):
            raise ActorToolError("Unsupported transform path: {}".format(text))
        part = parts[1]
        axes = {
            "location": ["x", "y", "z"],
            "rotation": ["roll", "pitch", "yaw"],
            "scale": ["x", "y", "z"],
        }.get(part)
        if axes is None:
            raise ActorToolError("Unsupported transform target: {}".format(part))
        axis = None
        if len(parts) == 3:
            axis = parts[2]
            if axis not in axes:
                raise ActorToolError("Unsupported transform axis '{}' for {}.".format(axis, part))
        return {"kind": "transform", "path": text, "part": part, "axis": axis, "axes": axes}

    component_match = re.match(r"^components\[([^\]]+)\]\.properties\.(.+)$", text, re.IGNORECASE)
    if component_match:
        selector = component_match.group(1).strip()
        prop = component_match.group(2).strip()
        if not prop:
            raise ActorToolError("Component property path is missing a property name: {}".format(text))
        _reject_transform_property_alias(prop)
        return {"kind": "component_property", "path": text, "selector": selector, "property": prop}

    if lower.startswith("properties."):
        prop = text[len("properties."):].strip()
        if not prop:
            raise ActorToolError("Actor property path is missing a property name: {}".format(text))
        _reject_transform_property_alias(prop)
        return {"kind": "actor_property", "path": text, "property": prop}

    if "." not in text and not lower.startswith("components["):
        _reject_transform_property_alias(text)
        if lower in {"actor", "transform", "components", "properties"}:
            raise ActorToolError("Reserved path '{}' needs a concrete child path.".format(text))
        return {"kind": "actor_property", "path": text, "property": text}

    raise ActorToolError("Unsupported actor update path: {}".format(text))


def _require_number(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ActorToolError("{} requires a numeric value.".format(path))
    return float(value)


def _require_number_list(value, path):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ActorToolError("{} requires an array of three numeric values.".format(path))
    return [_require_number(item, path) for item in value]


def _scalar_after(op, before, value, path):
    number = _require_number(value, path)
    if op == "set":
        return _clean_number(number)
    if op == "add":
        return _clean_number(float(before) + number)
    raise ActorToolError("Unsupported operation: {}".format(op))


def _sequence_after(op, before, value, path):
    values = _require_number_list(value, path)
    if op == "set":
        return [_clean_number(item) for item in values]
    if op == "add":
        return [_clean_number(float(before[index]) + values[index]) for index in range(3)]
    raise ActorToolError("Unsupported operation: {}".format(op))


def _set_actor_location(actor, values):
    vector = _make_vector(values)
    try:
        actor.set_actor_location(vector, sweep=False, teleport=True)
    except TypeError:
        actor.set_actor_location(vector, False, True)


def _set_actor_rotation(actor, values):
    rotator = _make_rotator(values)
    try:
        actor.set_actor_rotation(rotator, teleport_physics=True)
    except TypeError:
        actor.set_actor_rotation(rotator, True)


def _set_actor_scale(actor, values):
    actor.set_actor_scale3d(_make_vector(values))


def _plan_transform_operation(actor, parsed, op, value, index):
    part = parsed["part"]
    axis = parsed.get("axis")
    setter = {
        "location": "actor.set_actor_location",
        "rotation": "actor.set_actor_rotation",
        "scale": "actor.set_actor_scale3d",
    }[part]
    if part == "location":
        before_values = _vector_to_list(actor.get_actor_location())
        apply_setter = _set_actor_location
    elif part == "rotation":
        before_values = _rotator_to_list(actor.get_actor_rotation())
        apply_setter = _set_actor_rotation
    else:
        before_values = _vector_to_list(actor.get_actor_scale3d())
        apply_setter = _set_actor_scale

    writable = hasattr(actor, setter.split(".")[-1])
    if not writable:
        raise ActorToolError("{} is not available on this actor.".format(setter))

    if axis:
        axis_index = parsed["axes"].index(axis)
        before = before_values[axis_index]
        after = _scalar_after(op, before, value, parsed["path"])
        after_values = list(before_values)
        after_values[axis_index] = after
    else:
        before = before_values
        after_values = _sequence_after(op, before_values, value, parsed["path"])
        after = after_values

    def apply_change():
        apply_setter(actor, after_values)

    return {
        "index": index,
        "path": parsed["path"],
        "op": op,
        "before": before,
        "after": after,
        "setter": setter,
        "writable": True,
        "source": "transform",
    }, apply_change


def _coerce_property_value(before_raw, value, path):
    if isinstance(before_raw, bool):
        if not isinstance(value, bool):
            raise ActorToolError("{} expects a bool value.".format(path))
        return value
    if isinstance(before_raw, int) and not isinstance(before_raw, bool):
        return int(_require_number(value, path))
    if isinstance(before_raw, float):
        return float(_require_number(value, path))
    if isinstance(before_raw, str):
        if not isinstance(value, str):
            raise ActorToolError("{} expects a string value.".format(path))
        return value
    if _is_vector_like(before_raw):
        return _make_vector(_require_number_list(value, path))
    if _is_rotator_like(before_raw):
        return _make_rotator(_require_number_list(value, path))
    if isinstance(before_raw, (list, tuple)):
        if not isinstance(value, list):
            raise ActorToolError("{} expects an array value.".format(path))
        return value
    return value


def _add_property_value(before_raw, value, path):
    if isinstance(before_raw, bool):
        raise ActorToolError("{} cannot use add on a bool property.".format(path))
    if isinstance(before_raw, int) and not isinstance(before_raw, bool):
        return int(before_raw + _require_number(value, path))
    if isinstance(before_raw, float):
        return float(before_raw + _require_number(value, path))
    if _is_vector_like(before_raw):
        before = _vector_to_list(before_raw)
        return _make_vector(_sequence_after("add", before, value, path))
    if _is_rotator_like(before_raw):
        before = _rotator_to_list(before_raw)
        return _make_rotator(_sequence_after("add", before, value, path))
    raise ActorToolError("{} can only use add on numeric scalar, Vector, or Rotator properties.".format(path))


def _resolve_component(actor, selector):
    components = _actor_components(actor)
    selector_text = str(selector or "").strip()
    if re.match(r"^\d+$", selector_text):
        index = int(selector_text)
        if index < 0 or index >= len(components):
            raise ActorToolError(
                "Component index {} is out of range.".format(index),
                candidates=[_component_to_dict(component) for component in components[:20]],
            )
        return components[index]

    if selector_text.lower().startswith("name="):
        expected = selector_text[5:]
        matches = [component for component in components if _object_name(component) == expected]
    elif selector_text.lower().startswith("class="):
        expected = selector_text[6:]
        matches = [component for component in components if _object_class(component) == expected]
    else:
        raise ActorToolError("Unsupported component selector: {}".format(selector_text))

    if len(matches) == 1:
        return matches[0]
    candidates = [_component_to_dict(component) for component in matches[:20]]
    if not matches:
        candidates = [_component_to_dict(component) for component in components[:20]]
    raise ActorToolError(
        "Component selector '{}' matched {} components.".format(selector_text, len(matches)),
        candidates=candidates,
        next_step="Use components[index], components[name=ExactName], or a selector that resolves to one component.",
    )


def _plan_property_operation(target, prop, parsed, op, value, index, setter, source):
    if not hasattr(target, "set_editor_property"):
        raise ActorToolError("{} is not writable because set_editor_property is unavailable.".format(parsed["path"]))
    try:
        before_raw = target.get_editor_property(prop)
    except Exception as exc:
        raise ActorToolError("Could not read editor property '{}' for {}: {}".format(prop, parsed["path"], exc))
    if op == "set":
        after_raw = _coerce_property_value(before_raw, value, parsed["path"])
    elif op == "add":
        after_raw = _add_property_value(before_raw, value, parsed["path"])
    else:
        raise ActorToolError("Unsupported operation: {}".format(op))

    def apply_change():
        target.set_editor_property(prop, after_raw)

    return {
        "index": index,
        "path": parsed["path"],
        "op": op,
        "before": _jsonable(before_raw),
        "after": _jsonable(after_raw),
        "setter": setter,
        "writable": True,
        "source": source,
    }, apply_change


def _plan_actor_operation(actor, operation, index, warnings):
    parsed = _parse_actor_update_path(operation.get("path"))
    op = str(operation.get("op", "set"))
    value = operation.get("value")

    if parsed["kind"] == "label":
        if op != "set":
            raise ActorToolError("label only supports op=set.")
        if not hasattr(actor, "set_actor_label"):
            raise ActorToolError("actor.set_actor_label is not available on this actor.")
        after = ("" if value is None else str(value)).strip()
        if not after:
            raise ActorToolError("label cannot be empty.")
        before = _actor_label(actor)

        def apply_change():
            actor.set_actor_label(after, mark_dirty=True)

        return {
            "index": index,
            "path": parsed["path"],
            "op": op,
            "before": before,
            "after": after,
            "setter": "actor.set_actor_label",
            "writable": True,
            "source": "actor",
        }, apply_change

    if parsed["kind"] == "transform":
        return _plan_transform_operation(actor, parsed, op, value, index)

    if parsed["kind"] == "actor_property":
        warnings.add(
            "Actor editor properties can include non-UI or non-allow-listed UEFN fields; validate the project after changing {}.".format(parsed["property"])
        )
        return _plan_property_operation(
            actor,
            parsed["property"],
            parsed,
            op,
            value,
            index,
            "actor.set_editor_property",
            "editor_property",
        )

    if parsed["kind"] == "component_property":
        component = _resolve_component(actor, parsed["selector"])
        warnings.add(
            "Component editor properties can include non-UI or non-allow-listed UEFN fields; validate the project after changing {}.".format(parsed["property"])
        )
        return _plan_property_operation(
            component,
            parsed["property"],
            parsed,
            op,
            value,
            index,
            "component.set_editor_property",
            "component_editor_property",
        )

    raise ActorToolError("Unsupported operation path: {}".format(operation.get("path")))


def update_actor_on_main_thread(args):
    dry_run = args.get("dryRun", True) is not False
    operations = args.get("operations") or []
    result = _resolve_actor(args.get("actor"), args.get("matchBy", "label"))
    if not result.get("ok"):
        response = _actor_resolution_failure(result)
        response["dryRun"] = dry_run
        response["changes"] = []
        response["warnings"] = []
        response["operationCount"] = len(operations)
        response["changedCount"] = 0
        return response

    actor = result["actor"]
    warnings = set()
    changes = []
    apply_fns = []
    try:
        for index, operation in enumerate(operations):
            change, apply_fn = _plan_actor_operation(actor, operation, index, warnings)
            changes.append(change)
            apply_fns.append(apply_fn)
    except ActorToolError as exc:
        return {
            "ok": False,
            "dryRun": dry_run,
            "actor": _actor_to_dict(actor, "summary"),
            "operationCount": len(operations),
            "changedCount": 0,
            "changes": changes,
            "warnings": sorted(warnings),
            "componentCandidates": exc.candidates,
            "error": str(exc),
            "nextStep": exc.next_step,
        }

    changed_count = 0
    if not dry_run:
        for apply_fn in apply_fns:
            apply_fn()
            changed_count += 1

    return {
        "ok": True,
        "dryRun": dry_run,
        "actor": _actor_to_dict(actor, "summary"),
        "operationCount": len(operations),
        "changedCount": changed_count,
        "changes": changes,
        "warnings": sorted(warnings),
    }


def update_actor(args):
    return _run_on_editor_main_thread("update_actor", update_actor_on_main_thread, args)


def visual_context_issue(args):
    width = int(args.get("width", 1280))
    height = int(args.get("height", 720))
    camera_name = args.get("cameraName")
    camera_actor = None
    screenshot_dir = Path(_saved_dir()) / "Screenshots" / "Windows"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = screenshot_dir / "uefn_mcp_{}.png".format(int(time.time() * 1000))
    attempts = []

    if camera_name:
        try:
            camera_actor = _find_actor(camera_name)
            if hasattr(unreal, "EditorLevelLibrary"):
                unreal.EditorLevelLibrary.pilot_level_actor(camera_actor)
            attempts.append({"kind": "pilot_camera", "ok": True, "cameraName": camera_name})
        except Exception as exc:
            attempts.append({"kind": "pilot_camera", "ok": False, "error": str(exc)})

    try:
        unreal.AutomationLibrary.finish_loading_before_screenshot()
        attempts.append({"kind": "finish_loading_before_screenshot", "ok": True})
    except Exception as exc:
        attempts.append({"kind": "finish_loading_before_screenshot", "ok": False, "error": str(exc)})

    _invalidate_editor_viewports(attempts, "before_capture")

    if hasattr(unreal, "AutomationLibrary") and hasattr(unreal.AutomationLibrary, "take_high_res_screenshot"):
        try:
            task = unreal.AutomationLibrary.take_high_res_screenshot(
                width,
                height,
                str(screenshot_path),
                camera_actor,
                False,
                False,
                delay=0.0,
                force_game_view=True,
            )
            attempts.append({"kind": "automation_high_res_screenshot", "ok": True, "task": str(task)})
        except Exception as exc:
            attempts.append({"kind": "automation_high_res_screenshot", "ok": False, "error": str(exc)})

    try:
        world = unreal.EditorLevelLibrary.get_editor_world()
    except Exception:
        world = None

    command = 'HighResShot filename="{}" {}x{}'.format(str(screenshot_path), width, height)
    try:
        unreal.SystemLibrary.execute_console_command(world, command)
        attempts.append({"kind": "console_command", "command": command, "ok": True})
    except Exception as exc:
        attempts.append({"kind": "console_command", "command": command, "ok": False, "error": str(exc)})

    _invalidate_editor_viewports(attempts, "after_capture")

    scene_summary = None
    if args.get("includeSceneSummary", True):
        try:
            scene_summary = scene_context_issue({"limit": 30, "detailLevel": "summary"}).get("summary")
        except Exception as exc:
            scene_summary = {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "screenshotPath": str(screenshot_path),
        "resourceUri": "uefn://visual/{}".format(screenshot_path.name),
        "capture": {"width": width, "height": height, "cameraName": camera_name},
        "sceneSummary": scene_summary,
        "attempts": attempts,
    }


def visual_context(args):
    result = _run_on_editor_main_thread("visual_context", visual_context_issue, args)
    wait_ms = max(0, min(int(args.get("waitMs", 30000)), 120000))
    screenshot_path = result.get("screenshotPath", "")
    started_at = time.time()
    file_exists = os.path.exists(screenshot_path)
    while not file_exists and (time.time() - started_at) * 1000 < wait_ms:
        try:
            _run_on_editor_main_thread(
                "visual_context_invalidate",
                lambda invalidate_args: _invalidate_editor_viewports(invalidate_args["attempts"], "poll"),
                {"attempts": result["attempts"]},
                timeout_seconds=5,
            )
        except Exception:
            pass
        time.sleep(0.5)
        file_exists = os.path.exists(screenshot_path)
    result["fileExists"] = file_exists
    result["waitedMs"] = int((time.time() - started_at) * 1000)
    if not result["fileExists"]:
        result["ok"] = False
        result["pendingUntilViewportRedraw"] = True
        result["nextStep"] = "UEFN accepted the screenshot command but the file was not written. Switch focus to the UEFN viewport or click inside it so the editor renders another frame, then retry or read the screenshot folder."
    return result


def _invalidate_editor_viewports(attempts, phase):
    try:
        unreal.EditorLevelLibrary.editor_invalidate_viewports()
        attempts.append({"kind": "editor_invalidate_viewports", "phase": phase, "ok": True})
        return True
    except Exception as exc:
        attempts.append({"kind": "editor_invalidate_viewports", "phase": phase, "ok": False, "error": str(exc)})
        return False


def python_dry_run(args):
    script = args.get("script", "")
    if not isinstance(script, str) or not script.strip():
        raise RuntimeError("script is required.")

    script_hash = hashlib.sha256(script.encode("utf-8")).hexdigest()
    dry_run_id = "py_{}_{}".format(int(time.time()), script_hash[:10])
    warnings = []
    imports = []
    calls = []

    try:
        tree = ast.parse(script)
    except SyntaxError as exc:
        return {
            "ok": False,
            "blocked": True,
            "dryRunId": dry_run_id,
            "scriptHash": script_hash,
            "error": "SyntaxError: {}".format(exc),
            "nextStep": "Fix the Python syntax and run mode=dry_run again.",
        }

    risky_modules = {"os", "sys", "subprocess", "shutil", "socket", "requests", "urllib", "pathlib"}
    risky_calls = {"exec", "eval", "compile", "open", "__import__"}

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root_name = alias.name.split(".")[0]
                imports.append(alias.name)
                if root_name in risky_modules:
                    warnings.append("Imports potentially risky module: {}".format(alias.name))
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            imports.append(module)
            if module.split(".")[0] in risky_modules:
                warnings.append("Imports potentially risky module: {}".format(module))
        elif isinstance(node, ast.Call):
            call_name = _call_name(node.func)
            if call_name:
                calls.append(call_name)
                if call_name.split(".")[-1] in risky_calls:
                    warnings.append("Calls potentially risky function: {}".format(call_name))
                if call_name.endswith((".unlink", ".rmdir", ".remove", ".rename", ".replace", ".rmtree")):
                    warnings.append("Calls filesystem mutation function: {}".format(call_name))

    record = {
        "script": script,
        "scriptHash": script_hash,
        "dryRunId": dry_run_id,
        "createdAt": time.time(),
        "warnings": sorted(set(warnings)),
        "imports": sorted(set(imports)),
        "callsPreview": sorted(set(calls))[:80],
    }
    _dry_runs[dry_run_id] = record
    return {
        "ok": True,
        "blocked": False,
        "dryRunId": dry_run_id,
        "scriptHash": script_hash,
        "warnings": record["warnings"],
        "imports": record["imports"],
        "callsPreview": record["callsPreview"],
        "nextStep": "Review warnings. To execute exactly this script, call mode=execute with dryRunId and the same script.",
    }


def python_execute_on_main_thread(args):
    script = args.get("script", "")
    dry_run_id = args.get("dryRunId")
    script_hash = hashlib.sha256(script.encode("utf-8")).hexdigest()
    record = _dry_runs.get(dry_run_id)
    if not record:
        raise RuntimeError("Missing or unknown dryRunId. Run mode=dry_run first.")
    if record["scriptHash"] != script_hash:
        raise RuntimeError("Script hash does not match dryRunId. Run mode=dry_run again for this exact script.")

    namespace = {"unreal": unreal}
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(script, namespace, namespace)

    output = stdout.getvalue()
    errors = stderr.getvalue()
    return {
        "ok": True,
        "dryRunId": dry_run_id,
        "scriptHash": script_hash,
        "outputPreview": _truncate(output, 4000),
        "stderrPreview": _truncate(errors, 4000),
        "outputLength": len(output),
        "stderrLength": len(errors),
    }


def python_execute(args):
    return _run_on_editor_main_thread("python_execute", python_execute_on_main_thread, args)


def compile_verse_issue(args):
    attempts = []
    commands = ["Verse.Build", "BuildVerse", "BuildVerseScripts", "Fort.BuildVerse", "Solaris.BuildVerse"]
    try:
        world = unreal.EditorLevelLibrary.get_editor_world()
    except Exception:
        world = None

    for command in commands:
        try:
            unreal.SystemLibrary.execute_console_command(world, command)
            attempts.append({"kind": "console_command", "command": command, "ok": True})
        except Exception as exc:
            attempts.append({"kind": "console_command", "command": command, "ok": False, "error": str(exc)})

    accepted = [attempt["command"] for attempt in attempts if attempt.get("ok")]
    return {
        "ok": len(accepted) > 0,
        "buildTriggered": len(accepted) > 0,
        "acceptedCommands": accepted,
        "attempts": attempts,
    }


def compile_verse(args):
    return _run_on_editor_main_thread("compile_verse", compile_verse_issue, args)


def _call_name(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        base = _call_name(func.value)
        return "{}.{}".format(base, func.attr) if base else func.attr
    return None


def _saved_dir():
    try:
        return unreal.Paths.project_saved_dir()
    except Exception:
        return os.path.join(os.getcwd(), "Saved")


def _truncate(value, max_chars):
    return value if len(value) <= max_chars else value[: max_chars - 3] + "..."


def _next_step_for_error(tool_name, exc):
    if tool_name == "visual_context":
        return "Make sure the UEFN viewport is open and responsive, then retry with lower width/height or longer waitMs."
    if tool_name == "python_execute":
        return "Run python_dry_run first and execute the exact same script with the returned dryRunId."
    return "Check uefn_status, confirm the bridge is running inside UEFN, then retry. Original error: {}".format(exc)


TOOLS = {
    "list_actors": lambda args: _run_on_editor_main_thread("list_actors", list_actors, args),
    "scene_context": scene_context,
    "actor_details": actor_details,
    "update_actor": update_actor,
    "visual_context": visual_context,
    "python_dry_run": python_dry_run,
    "python_execute": python_execute,
    "compile_verse": compile_verse,
    "stop": lambda args: stop_server(),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json({
                "ok": unreal is not None,
                "service": "uefn_mcp_bridge",
                "version": VERSION,
                "unrealAvailable": unreal is not None,
                "menuRegistered": _menu_registered,
                "menuTargets": _menu_registered_targets[:12],
            })
            return
        self._send_json({"ok": False, "error": "Not found"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/tools/"):
            self._send_json({"ok": False, "error": "Not found"}, status=404)
            return

        tool_name = parsed.path.split("/")[-1]
        tool = TOOLS.get(tool_name)
        if tool is None:
            self._send_json({"ok": False, "error": "Unknown tool: {}".format(tool_name)}, status=404)
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length else "{}"
            args = json.loads(raw_body or "{}")
            result = tool(args)
            self._send_json(result)
        except Exception as exc:
            self._send_json({
                "ok": False,
                "error": str(exc),
                "nextStep": _next_step_for_error(tool_name, exc),
                "traceback": traceback.format_exc(),
            }, status=500)

    def log_message(self, fmt, *args):
        if unreal is not None:
            unreal.log("UEFN MCP bridge: " + fmt % args)

    def _send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=True, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if unreal is not None:
    try:
        register_menu()
    except Exception:
        pass
