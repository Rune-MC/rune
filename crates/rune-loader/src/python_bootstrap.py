"""Bridge a Rune script to Paper over the worker's standard streams."""

import asyncio
import inspect
import json
import pathlib
import runpy
import sys
import traceback
import types

_output = sys.stdout
_input = sys.stdin
_source = pathlib.Path(sys.argv[1])
_handlers = {}
_loading = True


def _send(**message):
    _output.write(json.dumps(message, allow_nan=False) + "\n")
    _output.flush()


def log(message, level="info"):
    _send(op="log", script=_source.stem, level=level, message=str(message))


class _Console:
    def __init__(self, level):
        self.level = level

    def write(self, text):
        if text.rstrip():
            log(text.rstrip(), self.level)
        return len(text)

    def flush(self):
        pass


def broadcast(message):
    _send(op="broadcast", message=str(message))


def on(event, priority="NORMAL"):
    priority = priority.upper()
    if priority not in {"LOWEST", "LOW", "NORMAL", "HIGH", "HIGHEST", "MONITOR"}:
        raise ValueError(f"invalid event priority: {priority}")

    def register(handler):
        key = f"{event}#{priority}"
        if key not in _handlers:
            _send(op="subscribe_event", name=event, priority=priority)
        _handlers.setdefault(key, []).append(handler)
        return handler

    return register


def command(name, *, description="", permission=None, aliases=()):
    def register(handler):
        if not _loading:
            raise RuntimeError("register commands while the Rune loads")
        key = f"__rune_command:{name}"
        if key in _handlers:
            raise ValueError(f"duplicate command: {name}")
        _send(op="register_command", name=name, description=description,
              permission=permission, aliases=list(aliases))
        _handlers[key] = [handler]
        return handler

    return register


def _snapshot(value):
    if isinstance(value, dict):
        return {name: _snapshot(item) for name, item in value.items() if name != "__ref"}
    if isinstance(value, list):
        return [_snapshot(item) for item in value]
    return value


async def _dispatch(event, data):
    for handler in _handlers.get(event, ()):
        try:
            result = handler(data)
            if inspect.isawaitable(result):
                await result
        except Exception:
            log(traceback.format_exc(), "error")


def _run():
    global _loading
    sdk = types.ModuleType("rune")
    sdk.broadcast, sdk.command, sdk.log, sdk.on = broadcast, command, log, on
    sys.modules["rune"] = sdk
    sys.path.insert(0, str(_source.parent))
    sys.argv = [str(_source)]
    sys.stdout = _Console("info")
    sys.stderr = _Console("error")
    try:
        runpy.run_path(str(_source), run_name="__main__")
    except (Exception, SystemExit):
        log(traceback.format_exc(), "error")
        _send(ready=False)
        return
    _loading = False
    _send(ready=True)
    loop = asyncio.new_event_loop()
    try:
        for line in _input:
            message = json.loads(line)
            loop.run_until_complete(_dispatch(message["event"], _snapshot(message["data"])))
    finally:
        loop.close()


_run()
