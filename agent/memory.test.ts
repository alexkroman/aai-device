import { afterEach, vi } from "vitest";
import { addMemories, allMemories, forgetMemory, searchMemories, updateMemory } from "./memory.ts";

// The four mem0 platform calls, pinned to the documented API
// (https://docs.mem0.ai/api-reference): a wrong path or entity field is a 400 only a
// live key would show.

const ctx = { env: { MEM0_API_KEY: "m0-test", MEM0_USER_ID: "test-home" } };

function stub(body: unknown = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return () => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
  };
}

afterEach(() => vi.unstubAllGlobals());

test("adds a conversation for the household, with the privacy hints", async () => {
  const sent = stub({ event_id: "e1", status: "PENDING" });
  await addMemories(ctx, [{ role: "user", content: "Biscuit can't do chicken" }], {
    metadata: { session_id: "s1" },
  });
  const { url, init, body } = sent();
  expect(url).toBe("https://api.mem0.ai/v3/memories/add/");
  expect((init.headers as Record<string, string>).Authorization).toBe("Token m0-test");
  expect(body).toMatchObject({ user_id: "test-home", metadata: { session_id: "s1" } });
  expect(body.excludes).toContain("verification codes");
});

test("lists and searches with the user inside filters, as v3 requires", async () => {
  let sent = stub({ results: [{ id: "m1", memory: "x" }] });
  expect(await allMemories(ctx)).toEqual([{ id: "m1", memory: "x" }]);
  expect(sent().body).toEqual({ filters: { user_id: "test-home" } });

  vi.unstubAllGlobals();
  sent = stub({ results: [] });
  await searchMemories(ctx, "the dog");
  expect(sent().url).toBe("https://api.mem0.ai/v3/memories/search/");
  expect(sent().body).toMatchObject({ query: "the dog", filters: { user_id: "test-home" } });
});

test("defaults to one household user when MEM0_USER_ID is unset", async () => {
  const sent = stub({ results: [] });
  await allMemories({ env: { MEM0_API_KEY: "m0-test" } });
  expect(sent().body).toEqual({ filters: { user_id: "household" } });
});

test("forgets by id", async () => {
  const sent = stub({ message: "Memory deleted successfully!" });
  await forgetMemory(ctx, "a1b2");
  expect(sent().url).toBe("https://api.mem0.ai/v1/memories/a1b2/");
  expect(sent().init.method).toBe("DELETE");
});

test("a refusal throws with the status, never the key", async () => {
  vi.stubGlobal("fetch", async () => new Response('{"detail":"bad key"}', { status: 401 }));
  await expect(allMemories(ctx)).rejects.toThrow(/mem0 401/);
  await expect(allMemories(ctx)).rejects.not.toThrow(/m0-test/);
});

test("edits by id with PUT, and a typed memory is stored without extraction", async () => {
  let sent = stub({ id: "a1b2" });
  await updateMemory(ctx, "a1b2", "Biscuit is allergic to chicken and beef");
  expect(sent().url).toBe("https://api.mem0.ai/v1/memories/a1b2/");
  expect(sent().init.method).toBe("PUT");
  expect(sent().body).toEqual({ text: "Biscuit is allergic to chicken and beef" });

  vi.unstubAllGlobals();
  sent = stub({ status: "SUCCEEDED" });
  await addMemories(ctx, [{ role: "user", content: "Biscuit is a beagle" }], { infer: false });
  expect(sent().body).toMatchObject({ infer: false });
});
