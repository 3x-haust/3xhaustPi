#!/usr/bin/env python3

import json
import os
import sys

SKIPPED_DIRECTORIES = {".git", "artifacts", "node_modules"}
MAX_MATCHES = 200
MAX_FILE_BYTES = 2 * 1024 * 1024
RESULT_CACHE: dict[tuple[str, str, str], list[str]] = {}


def search(root: str, revision: str, query: str) -> dict:
    cache_key = (root, revision, query)
    cached = RESULT_CACHE.get(cache_key)
    if cached is not None:
        return {"matches": cached, "cacheHit": True}
    matches: list[str] = []
    for directory, names, files in os.walk(root):
        names[:] = sorted(
            name
            for name in names
            if name not in SKIPPED_DIRECTORIES and not name.startswith(".")
        )
        for name in sorted(files):
            if name.startswith("."):
                continue
            path = os.path.join(directory, name)
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, "r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, start=1):
                        if query in line:
                            relative = os.path.relpath(path, root).replace(os.sep, "/")
                            matches.append(f"./{relative}:{line_number}:{line.rstrip()}")
                            if len(matches) >= MAX_MATCHES:
                                RESULT_CACHE[cache_key] = matches
                                if len(RESULT_CACHE) > 128:
                                    RESULT_CACHE.pop(next(iter(RESULT_CACHE)))
                                return {"matches": matches, "cacheHit": False}
            except (OSError, UnicodeDecodeError):
                continue
    RESULT_CACHE[cache_key] = matches
    if len(RESULT_CACHE) > 128:
        RESULT_CACHE.pop(next(iter(RESULT_CACHE)))
    return {"matches": matches, "cacheHit": False}


def respond(request: dict) -> dict:
    request_id = request.get("id")
    if (
        request.get("operation") != "search"
        or not isinstance(request.get("root"), str)
        or not os.path.isabs(request["root"])
        or not isinstance(request.get("query"), str)
        or not 0 < len(request["query"]) <= 512
        or not isinstance(request.get("revision"), str)
        or not 0 < len(request["revision"]) <= 512
    ):
        return {"id": request_id, "ok": False, "error": "invalid bounded read request"}
    result = search(request["root"], request["revision"], request["query"])
    return {"id": request_id, "ok": True, **result}


for raw_line in sys.stdin:
    try:
        parsed = json.loads(raw_line)
        output = respond(parsed if isinstance(parsed, dict) else {})
    except Exception as error:  # keep the worker alive for the next bounded request
        output = {"id": None, "ok": False, "error": str(error)[:512]}
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
