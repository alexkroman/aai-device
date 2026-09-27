"""Acoustic end-to-end tests: this computer speaks to the board through its
speakers (macOS `say`) and we assert on the production firmware's serial log.

Needs: production firmware flashed, the agent running (`aai dev`), the board
within a couple of meters of the speakers, and a reasonably quiet room.
"""

import os
import re
import subprocess
import time

import pytest
import serial


def pytest_addoption(parser):
    parser.addoption("--esp-port", default=os.environ.get("ESPPORT", "/dev/cu.usbmodem1101"))
    parser.addoption("--voice", default="Samantha", help="macOS `say` voice")


class DeviceLog:
    def __init__(self, port: str):
        self.ser = serial.Serial()
        self.ser.port, self.ser.baudrate, self.ser.timeout = port, 115200, 0.2
        self.ser.dtr = self.ser.rts = False  # don't reset the device on open
        self.ser.open()
        self.lines: list[str] = []

    def drain(self) -> None:
        self.ser.reset_input_buffer()
        self.lines.clear()

    def expect(self, pattern: str, timeout: float) -> re.Match:
        rx = re.compile(pattern)
        end = time.time() + timeout
        while time.time() < end:
            raw = self.ser.readline()
            if not raw:
                continue
            line = re.sub(r"\x1b\[[0-9;]*m", "", raw.decode(errors="replace")).rstrip()
            self.lines.append(line)
            print("  device|", line)
            if m := rx.search(line):
                return m
            if "Guru Meditation" in line or "abort()" in line:
                pytest.fail(f"device crashed: {line}")
        pytest.fail(f"timed out after {timeout}s waiting for /{pattern}/")


@pytest.fixture
def device(request):
    log = DeviceLog(request.config.getoption("--esp-port"))
    # Opening the port can reboot the board; if it's booting, wait until it's listening.
    end = time.time() + 1.5
    while time.time() < end:
        raw = log.ser.readline()
        if raw and b"boot:" in raw:
            log.expect(r"ready — say the wake word", timeout=20)
            break
    log.drain()
    yield log
    if not any("session ended" in line for line in log.lines):
        log.expect(r"session ended", timeout=30)  # leave it idle for the next test
    log.ser.close()


@pytest.fixture
def speak(request):
    voice = request.config.getoption("--voice")

    def _speak(text: str) -> None:
        print(f"  mac  | 🔊 {text}")
        subprocess.run(["say", "-v", voice, text], check=True)

    return _speak
