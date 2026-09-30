"""On-device Unity tests. Usage (from an ESP-IDF shell):

    cd firmware/test/device && pytest            # build, flash, run everything
    pytest --no-flash -k board                   # rerun one group on the flashed build

[agent] tests need the agent at CONFIG_AAI_AGENT_URL running (`aai dev`).
"""

import urllib.request
from urllib.parse import urlparse

import pytest


def check(result):
    assert result.cases, "no test cases ran"
    failures = "\n".join(f"  {name}: {msg}" for name, _, msg in result.failures)
    assert not result.failures, f"failed on device:\n{failures}"


def test_board(device):
    check(device.run_group("board", timeout=30))


def test_voice(device):
    check(device.run_group("voice", timeout=60))


def test_playback(device):
    check(device.run_group("playback", timeout=30))


def test_agent(device, agent_url):
    if not agent_url:
        pytest.skip("set CONFIG_AAI_AGENT_URL in sdkconfig.defaults.local: the test app has no discovery")
    health = f"http://{urlparse(agent_url).netloc}/health"
    try:
        urllib.request.urlopen(health, timeout=3)
    except OSError:
        pytest.skip(f"agent not reachable at {health}; start it with `aai dev`")
    check(device.run_group("agent", timeout=120))
