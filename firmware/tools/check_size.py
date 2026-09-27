"""Fail if the firmware outgrows its flash partition or static internal-RAM budget.

Internal RAM ran out at runtime once already (the websocket task couldn't start);
this catches static growth before it eats the heap headroom.

Usage: check_size.py <idf.py size --format json2 output> <app.bin> <partitions.csv>
"""

import json
import sys
from pathlib import Path

DIRAM_BUDGET = 0.70  # static data+bss+iram in internal RAM (was 63% on 2026-09-27)
APP_BUDGET = 0.60  # app binary vs its partition (was 39%)


def partition_size(csv: Path, name: str) -> int:
    for line in csv.read_text().splitlines():
        cols = [c.strip() for c in line.split(",")]
        if cols and cols[0] == name:
            size = cols[4]
            return int(size[:-1]) * 1024 * 1024 if size.endswith("M") else int(size, 0)
    raise SystemExit(f"no '{name}' partition in {csv}")


def main() -> int:
    layout = {m["name"]: m for m in json.loads(Path(sys.argv[1]).read_text())["layout"]}
    diram = layout["DIRAM"]
    app = Path(sys.argv[2]).stat().st_size
    part = partition_size(Path(sys.argv[3]), "factory")
    rows = [
        ("internal RAM (static)", diram["used"], diram["total"], DIRAM_BUDGET),
        ("app binary", app, part, APP_BUDGET),
    ]
    failed = False
    for label, used, total, budget in rows:
        pct = used / total
        ok = pct <= budget
        failed |= not ok
        print(
            f"{'ok  ' if ok else 'FAIL'} {label:22} {used / 1024:8.1f} / {total / 1024:.0f} KiB "
            f"= {pct:5.1%}  (budget {budget:.0%})"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
