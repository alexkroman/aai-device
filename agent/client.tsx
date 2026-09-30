/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient, phoneE164 } from "@alexkroman1/aai-ui";
import { App } from "./ui/app.tsx";
import { linked } from "./ui/client-id.ts";
import { PHONE_COUNTRY, phone } from "./ui/settings.ts";

// The browser twin of the speaker (ui/): what `aai dev` serves on :3000. The device
// itself talks to the same /websocket; this page only adds what a speaker can't do,
// typing and a transcript. Mount only, so an edit to a component fast-refreshes (the
// CLI's default React + Tailwind Vite config).
//
// Connecting an app (sidebar.tsx) opens Composio in a tab of its own, which comes back
// here with ?connected_account_id=. That tab has done its job: the page that opened it
// polls the app list. Left open it is one more live copy of the page, and each one
// played every notice aloud. The close only works on a tab a script opened; otherwise
// the query is dropped so a reload doesn't bring it back.
const back = new URL(location.href);
if (back.searchParams.has("connected_account_id")) {
  window.close();
  back.search = "";
  history.replaceState(null, "", back);
}
mountClient({
  component: App,
  name: "Home Speaker",
  // Where text_me and deep research text a browser session, read on every connect. No
  // ?location=: the household profile's address is the one everything uses (context.ts).
  phone: () => phoneE164(phone.get(), PHONE_COUNTRY),
  // The device's ?client=: what lets a reminder or a finished research job find this page
  // again after the session ends (useInbox holds the socket it arrives on).
  client: linked.id,
  theme: {
    bg: "#0c0c0e",
    primary: "#6d8bff",
    text: "#e7e7ea",
    surface: "#18181b",
    border: "#2a2a30",
  },
});
