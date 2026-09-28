/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient } from "@alexkroman1/aai-ui";
import { App } from "./ui/app.tsx";
import { clientId } from "./ui/client-id.ts";
import { setSessionId } from "./ui/session-id.ts";
import { readSetting } from "./ui/settings.ts";

// The browser twin of the speaker (ui/): what `aai dev` serves on :3000. The device
// itself talks to the same /websocket; this page only adds what a speaker can't do,
// typing and a transcript. Mount only, so an edit to a component fast-refreshes (see
// vite.config.ts).
mountClient({
  component: App,
  name: "Home Speaker",
  onSessionId: setSessionId,
  // What the device sends as ?location= (CONFIG_AAI_DEVICE_ADDRESS), and where text_me
  // and deep research text a browser session. Both are read on every connect.
  location: () => readSetting("location") || undefined,
  phone: () => readSetting("phone") || undefined,
  // The device's ?client=: what lets a reminder or a finished research job find this page
  // again after the session ends (ui/inbox.ts holds the socket it arrives on).
  client: clientId,
  theme: {
    bg: "#0c0c0e",
    primary: "#6d8bff",
    text: "#e7e7ea",
    surface: "#18181b",
    border: "#2a2a30",
  },
});
