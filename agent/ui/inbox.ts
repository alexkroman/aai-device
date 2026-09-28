// firmware inbox.c, in the browser: the socket a speaker holds open while idle, so a
// durable run (a reminder coming due, deep research finishing) can reach it after the
// session that started it is long gone. The agent pushes a notice as a JSON header, then
// its audio as binary frames, and resends it until this answers "ack". "busy" (mid-
// conversation, as the device answers) makes it come back later.

/** What the agent says out loud, and why: `event` is "reminder" or "research". */
export type Notice = {
  id: string;
  event: string;
  data?: Record<string, unknown>;
  /** PCM16LE mono at 16 kHz (workflows/remind.ts NOTICE_SAMPLE_RATE). */
  pcm: Uint8Array;
};

/** firmware PROTO_NOTICE_MAX_BYTES: 60 s of 16 kHz PCM16. */
const MAX_NOTICE_BYTES = 60 * 16_000 * 2;
/** firmware RECENT_IDS: acked ids remembered, so a redelivery after a lost ack isn't replayed. */
const RECENT_IDS = 8;

type Header = { id: string; event: string; data?: Record<string, unknown>; bytes: number };

/** proto_parse_notice(): a header this can take, or undefined (left unanswered, like the device). */
export function parseHeader(json: string): Header | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(json);
  } catch {
    return;
  }
  if (typeof msg !== "object" || msg === null) return;
  const { type, id, event, data, bytes } = msg as Record<string, unknown>;
  if (type !== "notice" || typeof id !== "string" || !id || typeof event !== "string") return;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return;
  if (bytes > MAX_NOTICE_BYTES || bytes % 2 !== 0) return;
  return {
    id,
    event,
    bytes,
    ...(typeof data === "object" && data !== null ? { data: data as Record<string, unknown> } : {}),
  };
}

export type Reply = { type: "ack" | "busy"; id: string };

/**
 * on_header() / on_bytes() / finish() without the socket: frames in, what to play and
 * what to answer out. `busy()` is asked when a header arrives.
 */
export function createAssembler(busy: () => boolean) {
  const recent: string[] = [];
  let pending: { header: Header; chunks: Uint8Array[]; got: number; play: boolean } | undefined;

  function finish(): { notice?: Notice; reply: Reply } | undefined {
    if (!pending) return;
    const { header, chunks, play } = pending;
    pending = undefined;
    if (!recent.includes(header.id)) {
      recent.push(header.id);
      if (recent.length > RECENT_IDS) recent.shift();
    }
    const reply: Reply = { type: "ack", id: header.id };
    if (!play) return { reply };
    const pcm = new Uint8Array(header.bytes);
    let at = 0;
    for (const c of chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    return {
      notice: {
        id: header.id,
        event: header.event,
        pcm,
        ...(header.data ? { data: header.data } : {}),
      },
      reply,
    };
  }

  return {
    /** A text frame. A header mid-notice cuts the last one short; it is resent unacked. */
    text(json: string): { notice?: Notice; reply: Reply } | undefined {
      const header = parseHeader(json);
      if (!header) return;
      if (!recent.includes(header.id) && busy()) {
        pending = undefined;
        return { reply: { type: "busy", id: header.id } };
      }
      pending = { header, chunks: [], got: 0, play: !recent.includes(header.id) };
      return header.bytes === 0 ? finish() : undefined;
    },
    /** A binary frame of the pending notice's audio; bytes with no header are dropped. */
    bytes(chunk: Uint8Array): { notice?: Notice; reply: Reply } | undefined {
      if (!pending) return;
      const room = pending.header.bytes - pending.got;
      const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
      pending.chunks.push(take);
      pending.got += take.length;
      return pending.got >= pending.header.bytes ? finish() : undefined;
    },
  };
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The client's live conversation, as the server streams it to a holder that asked for
 * events (`?events=1`): every session of the client, the speaker's included, so a linked
 * page shows what is said to the speaker as it is said.
 */
export type LiveEvent =
  | { type: "session_event"; sessionId: string; event: { type: string } & Record<string, unknown> }
  | { type: "session_ended"; sessionId: string };

/** A live-event frame, or undefined for anything else (a notice header, say). */
export function parseLiveEvent(json: string): LiveEvent | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(json);
  } catch {
    return;
  }
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as Record<string, unknown>;
  if (typeof m.sessionId !== "string") return;
  if (m.type === "session_ended") return { type: "session_ended", sessionId: m.sessionId };
  const event = m.event as Record<string, unknown> | undefined;
  if (m.type === "session_event" && event && typeof event.type === "string") {
    return {
      type: "session_event",
      sessionId: m.sessionId,
      event: event as { type: string } & Record<string, unknown>,
    };
  }
}

/**
 * Hold `WS /inbox?client=` open, reconnecting with backoff, as the device does from boot.
 * `holder` names THIS page among the client's holders, so a page joined to a speaker
 * shares its inbox rather than displacing it. Returns the function that closes it for good.
 */
export function openInbox(
  clientId: string,
  opts: {
    holder: string;
    busy: () => boolean;
    onNotice: (n: Notice) => void;
    onEvent?: (e: LiveEvent) => void;
    onOnline?: (up: boolean) => void;
  },
): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let delay = RECONNECT_MIN_MS;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const url = new URL("/inbox", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("client", clientId);
    url.searchParams.set("holder", opts.holder);
    if (opts.onEvent) url.searchParams.set("events", "1");
    const assembler = createAssembler(opts.busy);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws = socket;
    const handle = (out: { notice?: Notice; reply: Reply } | undefined) => {
      if (!out) return;
      if (out.notice) opts.onNotice(out.notice);
      socket.send(JSON.stringify(out.reply));
    };
    socket.onopen = () => {
      delay = RECONNECT_MIN_MS;
      opts.onOnline?.(true);
    };
    socket.onmessage = (e) => {
      if (typeof e.data === "string") {
        const live = opts.onEvent ? parseLiveEvent(e.data) : undefined;
        if (live) opts.onEvent?.(live);
        else handle(assembler.text(e.data));
      } else {
        handle(assembler.bytes(new Uint8Array(e.data as ArrayBuffer)));
      }
    };
    socket.onclose = () => {
      opts.onOnline?.(false);
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}
