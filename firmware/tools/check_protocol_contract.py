"""Check that every wire-protocol name the firmware depends on still exists in the SDK.

The firmware hard-codes event types, command types, JSON fields and URL params.
If the SDK renames one, the device silently stops reacting to it; this makes
that a build failure instead.

Usage: check_protocol_contract.py [path/to/aai/agent]   (default ~/Code/aai/agent)
"""

import re
import sys
from pathlib import Path

FW = Path(__file__).resolve().parent.parent
SDK = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Code/aai/agent")
SDK_PROTOCOL = SDK / "packages/aai/src/sdk"


def firmware_names() -> dict[str, set[str]]:
    protocol_c = (FW / "components/aai_device/protocol.c").read_text()
    agent_c = (FW / "components/aai_device/agent.c").read_text()
    return {
        # server -> device event types, matched in proto_parse()
        "event": set(re.findall(r'strcmp\(type, "([^"]+)"\)', protocol_c)),
        # JSON fields read from events
        "field": set(re.findall(r'cJSON_GetObjectItem\(msg, "([^"]+)"\)', protocol_c)),
        # device -> server command types and their fields
        "command": set(re.findall(r'\\"type\\":\\"([^\\]+)\\"', agent_c)),
        "command_field": set(re.findall(r'\\"(?!type\\")(\w+)\\":', agent_c)),
        # session URL query params
        "url_param": set(re.findall(r"%s(\w+)=", protocol_c)),  # "%s%sresume=1" -> resume
    }


def sdk_text(*names: str) -> str:
    return "\n".join((SDK_PROTOCOL / n).read_text() for n in names)


def main() -> int:
    if not SDK_PROTOCOL.is_dir():
        print(f"SDK not found at {SDK}; pass its path as the first argument")
        return 2
    events = sdk_text("protocol-events.ts")
    schemas = sdk_text("protocol-events.ts", "protocol.ts")
    commands = sdk_text("protocol-commands.ts")
    upgrade = sdk_text("ws-upgrade.ts")
    checks = {
        "event": lambda n: re.search(rf'(ev|z\.literal)\("{re.escape(n)}"', events),
        "field": lambda n: n == "type" or re.search(rf"\b{re.escape(n)}\??:", schemas),
        "command": lambda n: re.search(rf'(cmd|z\.literal)\("{re.escape(n)}"', commands),
        "command_field": lambda n: re.search(rf"\b{re.escape(n)}\??:", commands),
        "url_param": lambda n: re.search(rf'"{re.escape(n)}"', upgrade),
    }
    missing = []
    for kind, names in firmware_names().items():
        if not names:  # the extractor itself broke: fail instead of checking nothing
            print(f"MISSING {kind:14} (no names extracted from firmware; update this script)")
            missing.append(f"extractor for {kind}")
        for name in sorted(names):
            ok = bool(checks[kind](name))
            print(f"{'ok  ' if ok else 'MISSING'} {kind:14} {name}")
            if not ok:
                missing.append(f"{kind} {name!r}")
    if missing:
        print(f"\nThe SDK at {SDK} no longer defines: {', '.join(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
