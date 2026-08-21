#!/usr/bin/env python3

import json
import re
import sys

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # noqa: E402
except (ImportError, ValueError) as error:
    sys.stderr.write(f"Linux AT-SPI Python bindings are unavailable: {error}\n")
    raise SystemExit(1)


def bounded_text(value):
    normalized = re.sub(r"\s+", " ", str(value or "")).strip()
    return normalized[:512]


def children(element):
    count = max(0, min(4097, int(element.get_child_count())))
    return [element.get_child_at_index(index) for index in range(count)]


def process_id(element):
    getter = getattr(element, "get_process_id", None)
    return int(getter()) if getter else 0


def state_contains(element, state):
    try:
        return bool(element.get_state_set().contains(state))
    except Exception:
        return False


def canonical_identity(element):
    role_name = bounded_text(element.get_role_name()).lower()
    role = None
    if role_name in {"push button", "check box", "radio button", "toggle button", "button"}:
        role = "button"
    elif role_name in {"link", "hyperlink"}:
        role = "link"
    elif role_name in {"text", "entry", "password text", "combo box", "search box"}:
        role = "field"
    elif role_name in {"menu item", "check menu item", "radio menu item"}:
        role = "menu-item"
    elif role_name in {"frame", "window", "dialog", "alert", "panel"}:
        role = "window"
    if not role:
        return None
    name = bounded_text(element.get_name()) or role_name
    return {"role": role, "name": name} if name else None


def desktop():
    value = Atspi.get_desktop(0)
    if value is None:
        raise RuntimeError("Linux AT-SPI desktop is unavailable.")
    return value


def application_for_pid(pid):
    matches = [app for app in children(desktop()) if process_id(app) == int(pid)]
    if len(matches) != 1:
        raise RuntimeError(f"Linux AT-SPI application is unavailable: {pid}")
    return matches[0]


def list_applications():
    applications = []
    for application in children(desktop()):
        pid = process_id(application)
        name = bounded_text(application.get_name())
        if pid <= 0 or not name:
            continue
        applications.append(
            {
                "pid": pid,
                "name": name,
                "bundleId": f"atspi:{name}",
                "active": state_contains(application, Atspi.StateType.ACTIVE),
            }
        )
    applications.sort(key=lambda item: (not item["active"], item["name"].lower()))
    return {"platform": "linux", "trusted": True, "applications": applications[:128]}


def observe(request):
    application = application_for_pid(request["target"]["pid"])
    limit = max(1, min(512, int(request.get("maxElements", 512))))
    elements = []
    visited = 0

    def visit(element, path, depth):
        nonlocal visited
        if len(elements) >= limit or visited >= 512 or depth > 10:
            return
        visited += 1
        identity = canonical_identity(element)
        if identity:
            elements.append({**identity, "path": path})
        for index, child in enumerate(children(element)):
            if len(elements) >= limit or visited >= 512:
                break
            visit(child, [*path, index], depth + 1)

    identity = canonical_identity(application)
    if identity:
        elements.append({**identity, "path": [-1]})
    for index, child in enumerate(children(application)):
        if len(elements) >= limit or visited >= 512:
            break
        visit(child, [index], 1)
    return {
        "application": {
            "pid": process_id(application),
            "name": bounded_text(application.get_name()),
            "frontmost": state_contains(application, Atspi.StateType.ACTIVE),
        },
        "trusted": True,
        "elements": elements,
    }


def resolve_path(application, path):
    if not isinstance(path, list) or not 1 <= len(path) <= 17:
        raise RuntimeError("Linux AT-SPI element path is invalid.")
    if path == [-1]:
        return application
    element = application
    for index in path:
        index = int(index)
        if index < 0 or index > 4096:
            raise RuntimeError("Linux AT-SPI element path is invalid.")
        current_children = children(element)
        if index >= len(current_children):
            raise RuntimeError("Linux AT-SPI element path is stale.")
        element = current_children[index]
    return element


def interface(element, method_name):
    getter = getattr(element, method_name, None)
    return getter() if getter else None


def semantic_action(element, accepted_names):
    action = interface(element, "get_action_iface")
    if action is None:
        return False
    for index in range(int(action.get_n_actions())):
        name = bounded_text(action.get_action_name(index)).lower()
        if name in accepted_names:
            return bool(action.do_action(index))
    return False


def perform(request):
    action_request = request["action"]
    if request.get("coordinateFallback"):
        if action_request.get("action") != "click" or action_request.get("button") != "left":
            raise RuntimeError("Linux coordinate fallback supports approved left clicks only.")
        coordinates = action_request["coordinates"]
        if not Atspi.generate_mouse_event(int(coordinates["x"]), int(coordinates["y"]), "b1c"):
            raise RuntimeError("Linux AT-SPI coordinate click failed.")
        return {"method": "coordinates"}

    application = application_for_pid(request["target"]["pid"])
    element = resolve_path(application, request["path"])
    identity = canonical_identity(element)
    expected = request["expected"]
    if not identity or identity["role"] != expected["role"] or identity["name"] != expected["name"]:
        raise RuntimeError("Linux AT-SPI element identity changed before action.")

    action = action_request["action"]
    if action == "click":
        if action_request.get("button") != "left":
            raise RuntimeError("Semantic AT-SPI clicks support the left button only.")
        if not semantic_action(element, {"click", "press", "activate", "invoke", "toggle", "select"}):
            raise RuntimeError("Linux AT-SPI element has no semantic click action.")
    elif action == "type":
        editable = interface(element, "get_editable_text_iface")
        if editable is None or not editable.set_text_contents(str(action_request["text"])):
            raise RuntimeError("Linux AT-SPI element has no editable text interface.")
    elif action == "key":
        keys = {
            "Enter": "Return",
            "Escape": "Escape",
            "Tab": "Tab",
            "ArrowUp": "Up",
            "ArrowDown": "Down",
            "ArrowLeft": "Left",
            "ArrowRight": "Right",
        }
        component = interface(element, "get_component_iface")
        if component is not None:
            component.grab_focus()
        if not Atspi.generate_keyboard_event(0, keys[action_request["key"]], Atspi.KeySynthType.STRING):
            raise RuntimeError("Linux AT-SPI key synthesis failed.")
    else:
        accepted = {"scroll down", "page down", "increment"} if int(action_request["deltaY"]) >= 0 else {
            "scroll up",
            "page up",
            "decrement",
        }
        count = max(1, min(12, (abs(int(action_request["deltaY"])) + 799) // 800))
        for _ in range(count):
            if not semantic_action(element, accepted):
                raise RuntimeError("Linux AT-SPI element has no semantic scroll action.")
    return {"method": "accessibility"}


def main():
    Atspi.init()
    try:
        request = json.load(sys.stdin)
        operation = request.get("operation")
        if operation == "list":
            result = list_applications()
        elif operation == "observe":
            result = observe(request)
        elif operation == "perform":
            result = perform(request)
        else:
            raise RuntimeError("Unknown Linux AT-SPI operation.")
        json.dump(result, sys.stdout, separators=(",", ":"), ensure_ascii=False)
    finally:
        Atspi.exit()


try:
    main()
except Exception as error:
    sys.stderr.write(f"{error}\n")
    raise SystemExit(1)
