import alarmUrl from "../../firmware/components/aai_device/sounds/timer_alarm.pcm?url";

// The device's timer alarm, from the same file the firmware embeds (CMakeLists.txt
// EMBED_FILES), at the same gain and repeat pattern as firmware agent.c cue_load().
// (Its other cue, the wake chime, has no place here: this page has no wake word.)

const SAMPLE_RATE = 16_000; // firmware BOARD_SAMPLE_RATE; the files are PCM16LE mono at it
const ALARM_GAIN = 20_000 / 32_768;
const ALARM_HITS = 3;
const ALARM_GAP_S = 0.06;

let ctx: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
const playing = new Set<AudioBufferSourceNode>();

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * Call from a press or a keystroke. A timer rings long after any gesture, and an
 * AudioContext first made then stays suspended under the autoplay policy: silent.
 */
export function unlockAudio(): void {
  audio();
}

function load(url: string): Promise<AudioBuffer> {
  let buffer = buffers.get(url);
  if (!buffer) {
    buffer = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((bytes) => {
        const pcm = new Int16Array(bytes);
        const out = audio().createBuffer(1, pcm.length, SAMPLE_RATE);
        const samples = out.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32_768;
        return out;
      });
    buffers.set(url, buffer);
  }
  return buffer;
}

async function play(url: string, gain: number, hits = 1, gapS = 0): Promise<void> {
  const ac = audio();
  const buffer = await load(url);
  const level = ac.createGain();
  level.gain.value = gain;
  level.connect(ac.destination);
  let at = ac.currentTime;
  for (let i = 0; i < hits; i++) {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(level);
    src.onended = () => playing.delete(src);
    playing.add(src);
    src.start(at);
    at += buffer.duration + gapS;
  }
}

export const playAlarm = () => play(alarmUrl, ALARM_GAIN, ALARM_HITS, ALARM_GAP_S);

/** firmware agent_stop_cues(): silence what is queued, e.g. the rest of a ring. */
export function stopCues(): void {
  for (const src of playing) src.stop();
  playing.clear();
}
