"""Minimal driver for ESP-IDF's Unity test menu over USB-Serial-JTAG.

We don't use pytest-embedded. On this board, repeated DTR/RTS resets over the
ESP32-S3 USB-Serial-JTAG can wedge the chip until it is power-cycled, so this
runner avoids resets entirely: `idf.py flash` leaves the app booted at the
Unity menu, the port is opened with DTR/RTS held low (plain open() asserts
both), and every group runs in that one boot. The Unity cases' init helpers are
idempotent, so they don't need a fresh boot each.
"""

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import serial

HERE = Path(__file__).parent
RESULT = re.compile(
    r"^(?P<file>[^:\s]+):(?P<line>\d+):(?P<name>.+?):(?P<status>PASS|FAIL|IGNORE)(?::(?P<msg>.*))?$"
)
CRASH_MARKERS = ("Guru Meditation", "abort() was called", "assert failed")
SUMMARY = re.compile(r"^(\d+) Tests (\d+) Failures (\d+) Ignored")


def pytest_addoption(parser):
    parser.addoption("--esp-port", default=os.environ.get("ESPPORT", "/dev/cu.usbmodem1101"))
    parser.addoption("--no-flash", action="store_true", help="test the firmware already on the board")


@dataclass
class GroupResult:
    cases: list = field(default_factory=list)  # (name, status, message)
    log: list = field(default_factory=list)

    @property
    def failures(self):
        return [c for c in self.cases if c[1] == "FAIL"]


class UnityDevice:
    def __init__(self, port: str):
        self.port = port
        self.ser: serial.Serial | None = None

    def open(self) -> None:
        self.ser = serial.Serial()
        self.ser.port = self.port
        self.ser.baudrate = 115200
        self.ser.timeout = 0.2
        self.ser.dtr = False  # set before open() so opening doesn't pulse reset/boot lines
        self.ser.rts = False
        self.ser.open()
        # Already at the menu (after flash, or between groups)? Enter re-prints it.
        self.ser.write(b"\n")
        try:
            self._wait_for("Enter test for running", timeout=30)
        except TimeoutError:
            self.reset()

    def reset(self) -> None:
        """Fallback only: RTS pulse with DTR released = normal boot."""
        self.ser.rts = True
        time.sleep(0.1)
        self.ser.rts = False
        self._wait_for("Press ENTER to see the list of tests", timeout=40)

    def _readline(self) -> str | None:
        raw = self.ser.readline()
        return raw.decode(errors="replace").rstrip("\r\n") if raw else None

    def _wait_for(self, text: str, timeout: float) -> None:
        end = time.time() + timeout
        while time.time() < end:
            line = self._readline()
            if line is not None and text in line:
                return
        raise TimeoutError(f"device never printed {text!r}")

    def run_group(self, tag: str, timeout: float) -> GroupResult:
        """Run every case tagged [tag] from the Unity menu."""
        self.ser.write(f"[{tag}]\n".encode())
        result = GroupResult()
        end = time.time() + timeout
        while time.time() < end:
            line = self._readline()
            if line is None:
                continue
            result.log.append(line)
            print(line)
            if m := RESULT.match(line):
                result.cases.append((m["name"], m["status"], m["msg"] or ""))
            elif SUMMARY.match(line):
                self._wait_for("Enter next test", timeout=5)
                return result
            elif any(marker in line for marker in CRASH_MARKERS):
                raise AssertionError(f"device crashed during [{tag}]: {line}")
        raise TimeoutError(f"[{tag}] did not finish within {timeout}s")


@pytest.fixture(scope="session")
def device(request) -> UnityDevice:
    port = request.config.getoption("--esp-port")
    if not request.config.getoption("--no-flash"):
        idf_py = Path(os.environ["IDF_PATH"]) / "tools/idf.py"  # needs an ESP-IDF shell (export.sh)
        subprocess.run(
            [sys.executable, str(idf_py), "-p", port, "build", "flash"],
            cwd=HERE,
            check=True,
            stdout=subprocess.DEVNULL,
        )
    dev = UnityDevice(port)
    dev.open()
    yield dev
    if dev.ser:
        dev.ser.close()


@pytest.fixture(scope="session")
def agent_url() -> str:
    cfg = json.loads((HERE / "build/config/sdkconfig.json").read_text())
    return cfg["AAI_AGENT_URL"]  # empty: the firmware finds it over mDNS, but the test app doesn't
