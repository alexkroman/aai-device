import { codeMatches, hashCode, mintDigitCode } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { rest } from "./supabase.ts";

// Joining a browser to a speaker's conversation. The page asks for a code (createLinkCode)
// and shows it; someone in the room says it to the speaker ("computer, link code 4 8 2 9
// 1 3"), whose link_browser tool claims it (claimLinkCode) with the speaker's own client
// id; the page, polling linkStatus, adopts that id and from then on IS that speaker's
// conversation: its history, its live turns, its reminders.
//
// Saying the code is the proof: only someone near the speaker can hear the page's code
// AND speak to the speaker, so a stranger on the LAN cannot join a speaker by guessing.

export const LINK_CODE_DIGITS = 6;
export const LINK_CODE_TTL_MS = 5 * 60 * 1000;
/** Wrong codes tried against the pending ones before they all die. */
export const MAX_LINK_ATTEMPTS = 5;

/**
 * A fresh code for this browser. Every earlier row of its goes, claimed ones too: after
 * an unlink, an old claim must not link it straight back to the old speaker.
 */
export async function createLinkCode(
  ctx: EnvContext,
  browserClient: string,
  now = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  await rest(ctx, `/link_codes?browser_client=eq.${enc(browserClient)}`, { method: "DELETE" });
  const code = mintDigitCode(LINK_CODE_DIGITS);
  const expiresAt = now + LINK_CODE_TTL_MS;
  await rest(ctx, "/link_codes", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      // hashCode is SHA-256 as lower-case hex, what this column has always held.
      code_sha256: await hashCode(code),
      browser_client: browserClient,
      expires_at: new Date(expiresAt).toISOString(),
    },
  });
  return { code, expiresAt };
}

export type ClaimResult =
  | { status: "linked"; browserClient: string }
  | { status: "wrong"; attemptsLeft: number }
  | { status: "none_pending" };

/** The speaker's half: the code as said, and the speaker's own client id. */
export async function claimLinkCode(
  ctx: EnvContext,
  said: string,
  speakerClient: string,
  now = Date.now(),
): Promise<ClaimResult> {
  const pending = await rest<
    { id: number; code_sha256: string; browser_client: string; attempts: number }[]
  >(
    ctx,
    "/link_codes?select=id,code_sha256,browser_client,attempts&speaker_client=is.null" +
      `&expires_at=gt.${new Date(now).toISOString()}&attempts=lt.${MAX_LINK_ATTEMPTS}`,
  );
  if (pending.length === 0) return { status: "none_pending" };
  // codeMatches per row (it normalizes `said` and compares in constant time), not one
  // hash looked up with ===: the lookup would be the non-constant-time compare again.
  let match: (typeof pending)[number] | undefined;
  for (const p of pending) {
    if (await codeMatches(said, p.code_sha256)) {
      match = p;
      break;
    }
  }
  if (!match) {
    // Every pending code pays for a wrong guess: the guesser does not know which one it hit.
    const ids = pending.map((p) => p.id).join(",");
    const attempts = Math.max(...pending.map((p) => p.attempts)) + 1;
    await rest(ctx, `/link_codes?id=in.(${ids})`, { method: "PATCH", body: { attempts } });
    return { status: "wrong", attemptsLeft: Math.max(0, MAX_LINK_ATTEMPTS - attempts) };
  }
  await rest(ctx, `/link_codes?id=eq.${match.id}`, {
    method: "PATCH",
    body: { speaker_client: speakerClient },
  });
  return { status: "linked", browserClient: match.browser_client };
}

/** The page's poll: the speaker it was linked to, once a code of its was claimed. */
export async function linkStatus(
  ctx: EnvContext,
  browserClient: string,
): Promise<string | undefined> {
  const rows = await rest<{ speaker_client: string | null }[]>(
    ctx,
    `/link_codes?select=speaker_client&browser_client=eq.${enc(browserClient)}` +
      "&speaker_client=not.is.null&order=created_at.desc&limit=1",
  );
  return rows[0]?.speaker_client ?? undefined;
}

const enc = encodeURIComponent;
