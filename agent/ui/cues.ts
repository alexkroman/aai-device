// What the page plays besides the agent's own voice: notices from the inbox (ui/inbox.ts),
// at the rate the firmware plays them. (The device's wake chime has no place here: this
// page has no wake word.)

const SAMPLE_RATE = 16_000; // firmware BOARD_SAMPLE_RATE; notices are PCM16LE mono at it

let ctx: AudioContext | undefined;
const playing = new Set<AudioBufferSourceNode>();

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * Call from a press or a keystroke. A reminder arrives long after any gesture, and an
 * AudioContext first made then stays suspended under the autoplay policy: silent.
 */
export function unlockAudio(): void {
  audio();
}

/** A notice from the inbox (ui/inbox.ts): PCM16LE mono at SAMPLE_RATE, as the device plays it. */
export function playPcm(bytes: Uint8Array): void {
  const ac = audio();
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  if (pcm.length === 0) return;
  const buffer = ac.createBuffer(1, pcm.length, SAMPLE_RATE);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32_768;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.connect(ac.destination);
  src.onended = () => playing.delete(src);
  playing.add(src);
  src.start();
}

/** firmware inbox_stop_notice(): silence a notice that is playing. */
export function stopCues(): void {
  for (const src of playing) src.stop();
  playing.clear();
}
