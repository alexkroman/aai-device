"""Fail if host-test coverage of the pure-logic modules drops below the floor.

Usage: check_coverage.py <llvm-cov export -summary-only JSON>
"""

import json
import sys
from pathlib import Path

FLOORS = {"lines": 90.0, "branches": 85.0, "functions": 100.0}
MODULES = ("components/aai_device/protocol.c",)


def main() -> int:
    data = json.loads(Path(sys.argv[1]).read_text())
    failed = False
    for f in data["data"][0]["files"]:
        if not f["filename"].endswith(MODULES):
            continue
        name = f["filename"].split("firmware/")[-1]
        for metric, floor in FLOORS.items():
            pct = f["summary"][metric]["percent"]
            ok = pct >= floor
            failed |= not ok
            print(f"{'ok  ' if ok else 'FAIL'} {name:40} {metric:10} {pct:6.1f}%  (floor {floor}%)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
