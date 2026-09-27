"""Run from an ESP-IDF shell:  cd firmware/test/e2e && pytest"""

import time

WAKE = "Computer"  # must match CONFIG_SR_WN_* in firmware/sdkconfig.defaults


def test_ask_the_weather(device, speak):
    speak(WAKE)
    device.expect(r"wake word detected", timeout=5)
    time.sleep(0.4)  # let the wake chime finish
    speak("What's the weather in Denver?")
    device.expect(r"agent: session .*: mic \d+ Hz", timeout=10)
    you = device.expect(r"agent: you: (.*)", timeout=20).group(1)
    assert "weather" in you.lower() and "denver" in you.lower(), f"misheard: {you!r}"
    device.expect(r"agent: tool: \w+", timeout=15)  # whichever weather tool the agent has
    reply = device.expect(r"agent: agent: (.*)", timeout=20).group(1)
    assert "denver" in reply.lower() or "degrees" in reply.lower(), reply


def test_wake_word_interrupts_the_agent(device, speak):
    speak(WAKE)
    device.expect(r"wake word detected", timeout=5)
    time.sleep(0.4)
    speak("Tell me a long story about a dragon who learns to bake bread.")
    device.expect(r"agent: you: ", timeout=20)
    time.sleep(4)  # it's mid-story now
    speak(WAKE)
    device.expect(r"reply\.cancelled: flushing playback", timeout=8)


def test_goes_back_to_sleep(device, speak):
    speak(WAKE)
    device.expect(r"wake word detected", timeout=5)
    time.sleep(0.4)
    speak("Thanks, that's all.")
    device.expect(r"agent: agent: ", timeout=25)
    start = time.time()
    device.expect(r"session ended", timeout=25)
    assert time.time() - start < 20, "follow-up window ran long"
