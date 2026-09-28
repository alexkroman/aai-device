import { rest } from "./supabase.ts";

// The household profile: the few exact facts tools act on, kept in the `profile` table
// (../supabase/migrations). Nothing is configured in code or .env: a tool that needs a
// field that is not saved yet fails with an instruction to ask for it
// (`missingField`), the model asks, and `update_profile` saves the answer.
//
// A phone number is never saved as said. It is texted a code first and becomes
// `phone` only when that code is read back (tools/confirm_phone.ts): the agent listens
// on the LAN, so otherwise anyone who can open a session could point its texts at a
// stranger's number.

type Ctx = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

/** The fields a person can set, and what each is for (shown to the model). */
export const PROFILE_FIELDS = {
  name: "What to call them",
  home_address: "Their street address, for weather, pollen and places near home",
  phone: "Their mobile number, where texts and research reports go",
} as const;
export type ProfileField = keyof typeof PROFILE_FIELDS;

export type Profile = Partial<Record<ProfileField, string>> & {
  /** "lat,lng" of home_address, saved with it so a lookup near home costs no geocode. */
  home_coords?: string;
};

let cached: Profile = {};
let cachedAt = 0;
let refreshing: Promise<Profile> | undefined;
const CACHE_MS = 30_000;

/** The whole profile, fresh from the database. */
export async function readProfile(ctx: Ctx): Promise<Profile> {
  const rows = await rest<{ key: string; value: string }[]>(ctx, "/profile?select=key,value");
  cached = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Profile;
  cachedAt = Date.now();
  return cached;
}

/**
 * The profile as last read, for the system prompt, which is resolved synchronously on
 * every model step and so cannot wait on the database. A stale copy starts a refresh
 * for the next step. Tools never use this: they read fresh.
 */
export function cachedProfile(ctx: Ctx): Profile {
  if (Date.now() - cachedAt > CACHE_MS && !refreshing) {
    refreshing = readProfile({ env: ctx.env })
      .catch(() => cached)
      .finally(() => {
        refreshing = undefined;
      });
  }
  return cached;
}

/** Save fields, or delete the ones given as null. */
export async function writeProfile(
  ctx: Ctx,
  fields: Partial<Record<keyof Profile, string | null>>,
): Promise<void> {
  const entries = Object.entries(fields);
  const set = entries
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  const cleared = entries.filter(([, v]) => v === null).map(([k]) => k);
  if (set.length) {
    await rest(ctx, "/profile?on_conflict=key", {
      method: "POST",
      body: set,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  if (cleared.length) {
    await rest(ctx, `/profile?key=in.(${cleared.join(",")})`, { method: "DELETE" });
  }
  await readProfile(ctx);
}

/** The failure a tool returns when a field it needs is not saved: it tells the model to ask. */
export function missingField(field: ProfileField, forWhat: string): string {
  const how =
    field === "phone"
      ? "Ask for their mobile number, then call update_profile with it; they will get a code to read back."
      : `Ask for it, then call update_profile with field "${field}" and try again.`;
  return `I don't have their ${field.replace("_", " ")} yet, which I need ${forWhat}. ${how}`;
}

/** The profile as the system prompt states it. */
export function describeProfile(profile: Profile): string {
  const lines = [
    profile.name && `Their name is ${profile.name}.`,
    profile.home_address && `Their home address is ${profile.home_address}.`,
    profile.phone && `Texts go to their number ending in ${profile.phone.slice(-4)}.`,
  ].filter(Boolean);
  return lines.length ? `What you know about the household: ${lines.join(" ")}` : "";
}

// --- Phone numbers ---------------------------------------------------------

/**
 * E.164, or undefined when it can't be one. A bare 10-digit number is taken as US/Canada
 * (+1), the one assumption here: say the country code for anywhere else.
 */
export function normalizePhone(said: string): string | undefined {
  const digits = said.replace(/[\s().-]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return undefined;
}

/** How a number is said back: only its last four digits. */
export function spokenPhone(phone: string): string {
  return `the number ending in ${phone.slice(-4).split("").join(" ")}`;
}

/** Codes texted per day, across all numbers: each one costs a text. */
export const MAX_CODES_PER_DAY = 5;
export const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Text via Textbelt; throws with Textbelt's own reason, which the model can say. */
export async function sendText(ctx: Ctx, phone: string, message: string): Promise<void> {
  const key = ctx.env.TEXTBELT_KEY;
  if (!key) throw new Error("Texting is not set up: TEXTBELT_KEY is missing from agent/.env");
  const res = await fetch("https://textbelt.com/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, message, key }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!res.ok || !body.success) throw new Error(body.error ?? `Textbelt HTTP ${res.status}`);
}

export type StartResult =
  | { status: "sent"; phone: string }
  | { status: "unchanged" }
  | { status: "invalid" }
  | { status: "rate_limited" };

/** Text a code to `said`, to be read back to `confirmPhone`. */
export async function startPhoneVerification(ctx: Ctx, said: string): Promise<StartResult> {
  const phone = normalizePhone(said);
  if (!phone) return { status: "invalid" };
  if ((await readProfile(ctx)).phone === phone) return { status: "unchanged" };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await rest<{ id: number }[]>(
    ctx,
    `/phone_verification?select=id&created_at=gte.${encodeURIComponent(since)}`,
  );
  if (recent.length >= MAX_CODES_PER_DAY) return { status: "rate_limited" };

  const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
  const code = String(random % 1_000_000).padStart(6, "0");
  const [row] = await rest<{ id: number }[]>(ctx, "/phone_verification", {
    method: "POST",
    body: {
      phone,
      code_sha256: await sha256(code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    },
    prefer: "return=representation",
  });
  try {
    await sendText(
      ctx,
      phone,
      `Your Home Speaker code is ${code}. Say it to the speaker to confirm this number.`,
    );
  } catch (err) {
    // No text went out, so no code can be read back: don't let the row count
    // against the day's limit either.
    if (row) await rest(ctx, `/phone_verification?id=eq.${row.id}`, { method: "DELETE" });
    throw err;
  }
  return { status: "sent", phone };
}

export type ConfirmResult =
  | { status: "confirmed"; phone: string }
  | { status: "wrong"; attemptsLeft: number }
  | { status: "none_pending" };

/** Check a code read back against the newest pending one; a match saves the number. */
export async function confirmPhone(ctx: Ctx, code: string): Promise<ConfirmResult> {
  const now = encodeURIComponent(new Date().toISOString());
  const [pending] = await rest<
    { id: number; phone: string; code_sha256: string; attempts: number }[]
  >(
    ctx,
    `/phone_verification?select=id,phone,code_sha256,attempts&expires_at=gt.${now}` +
      `&attempts=lt.${MAX_ATTEMPTS}&order=created_at.desc&limit=1`,
  );
  if (!pending) return { status: "none_pending" };

  if ((await sha256(code.replace(/\D/g, ""))) !== pending.code_sha256) {
    const attempts = pending.attempts + 1;
    await rest(ctx, `/phone_verification?id=eq.${pending.id}`, {
      method: "PATCH",
      body: { attempts },
    });
    return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - attempts };
  }
  await writeProfile(ctx, { phone: pending.phone });
  // Spent: expire it rather than delete it, so it still counts against the day's limit.
  await rest(ctx, `/phone_verification?id=eq.${pending.id}`, {
    method: "PATCH",
    body: { expires_at: new Date().toISOString() },
  });
  return { status: "confirmed", phone: pending.phone };
}
