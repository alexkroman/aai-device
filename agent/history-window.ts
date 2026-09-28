// How long a finished session is replayed word for word on the next connect, before its
// digest stands in for it (context.ts). Its own module, with no imports, because the page
// shows it too (ui/sidebar.tsx) and must not pull the agent's server code into its bundle.

/** Sessions this recent are replayed verbatim; older ones are digests. */
export const VERBATIM_WINDOW_MS = 6 * 60 * 60 * 1000;
