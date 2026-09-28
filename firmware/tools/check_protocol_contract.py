"""Check that every wire-protocol name the firmware depends on still exists in the SDK.

The firmware hard-codes event types, command types, JSON fields and URL params.
If the SDK renames one, the device silently stops reacting to it; this makes
that a build failure instead.

Custom events are a second contract, with this repo's own agent: each one the firmware
matches must still be sent by a tool in agent/tools/ (ctx.send).

The inbox (inbox.c, WS /inbox) is a third: its path, the notice header fields the firmware
reads and the replies it sends must still be what the SDK's client inbox speaks.

Usage: check_protocol_contract.py [path/to/aai/agent]   (default ~/Code/aai/agent)
"""

import re
import sys
from pathlib import Path

FW = Path(__file__).resolve().parent.parent
SDK = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Code/aai/agent")
SDK_PROTOCOL = SDK / "packages/aai/src/sdk"
SDK_RUNTIME = SDK / "packages/aai-runtime/src"
AGENT_TOOLS = FW.parent / "agent/tools"
DATA_FIELD_READ = r'cJSON_GetObjectItem\(cJSON_GetObjectItem\([^)]*\), "([^"]+)"\)'  # data.<field>


def firmware_names() -> dict[str, set[str]]:
    protocol_c = (FW / "components/aai_device/protocol.c").read_text()
    agent_c = (FW / "components/aai_device/agent.c").read_text()
    inbox_c = (FW / "components/aai_device/inbox.c").read_text()
    notice_parser = protocol_c[protocol_c.index("bool proto_parse_notice(") :]
    notice_parser = notice_parser[: notice_parser.index("\n}\n")]
    session_c = protocol_c.replace(notice_parser, "")  # proto_parse() and the URL builders
    return {
        # server -> device event types, matched in proto_parse()
        "event": set(re.findall(r'strcmp\(type, "([^"]+)"\)', session_c)),
        # JSON fields read from events
        "field": set(re.findall(r'cJSON_GetObjectItem\(msg, "([^"]+)"\)', session_c)),
        # device -> server command types and their fields
        "command": set(re.findall(r'\\"type\\":\\"([^\\]+)\\"', agent_c)),
        "command_field": set(re.findall(r'\\"(?!type\\")(\w+)\\":', agent_c)),
        # session URL query params
        "url_param": set(re.findall(r"%s(\w+)=", protocol_c))  # "%s%sresume=1" -> resume
        | set(re.findall(r'append_param\([^;]*?"(\w+)", \w+\)', protocol_c)),  # ..."client", id)
        # the inbox: its path and query param, the notice fields read, the replies sent
        "inbox_path": set(re.findall(r"(/\w+)\?client=", protocol_c)),
        "notice_field": set(re.findall(r'cJSON_GetObjectItem\(msg, "([^"]+)"\)', notice_parser)),
        # read from `data`: this repo's agent's convention, like the custom event fields
        "notice_data_field": set(re.findall(DATA_FIELD_READ, notice_parser)),
        "notice_reply": set(re.findall(r'reply\("(\w+)"', inbox_c)),
        # custom.emitted events from agent/tools/. None reads fields from its data today
        # ("stop" has none); check those against the tools too when one does.
        "custom_event": set(re.findall(r'strcmp\(event, "([^"]+)"\)', protocol_c)),
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
    notify = sdk_text("step-notify-client.ts")  # its module doc carries the wire format
    inbox = (SDK_RUNTIME / "client-inbox.ts").read_text()
    tools = "\n".join(f.read_text() for f in sorted(AGENT_TOOLS.glob("*.ts")))
    workflows = "\n".join(f.read_text() for f in sorted((AGENT_TOOLS.parent / "workflows").glob("*.ts")))
    checks = {
        "event": lambda n: re.search(rf'(ev|z\.literal)\("{re.escape(n)}"', events),
        "field": lambda n: n == "type" or re.search(rf"\b{re.escape(n)}\??:", schemas),
        "command": lambda n: re.search(rf'(cmd|z\.literal)\("{re.escape(n)}"', commands),
        "command_field": lambda n: re.search(rf"\b{re.escape(n)}\??:", commands),
        "url_param": lambda n: re.search(rf'"{re.escape(n)}"', upgrade),
        "inbox_path": lambda n: re.search(rf'CLIENT_INBOX_PATH = "{re.escape(n)}"', inbox)
        and re.search(r'get\("client"\)', inbox),
        "notice_field": lambda n: (
            re.search(rf'"{re.escape(n)}"', notify) or re.search(rf"\b{re.escape(n)}:", inbox)
        ),
        "notice_data_field": lambda n: re.search(
            rf"stepNotifyClient\([^;]*data: \{{[^}}]*\b{re.escape(n)}\b", workflows
        ),
        "notice_reply": lambda n: re.search(rf'msg\.type === "{re.escape(n)}"', inbox),
        "custom_event": lambda n: re.search(rf'ctx\.send\(\s*"{re.escape(n)}"', tools),
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
