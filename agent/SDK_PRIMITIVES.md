# The aai SDK primitives this agent is built on

The Home Speaker is an Alexa-style voice agent for an ESP32-S3 board. It sets reminders
that fire days later, places real phone calls, runs deep research that takes minutes,
works in the household's Gmail, Calendar and Slack, and remembers what it was told. Most
of that is the SDK's doing, not this project's: `agent.ts` is about a hundred lines, and
almost every hard part (durability, delivery to a speaker that may be asleep, telephony,
OAuth'd app access, testing a voice agent) maps onto one primitive from `@alexkroman1/aai`.

This is a tour of those primitives, grouped by the problem each one solves, with where
this project uses it. The authoritative reference is the guide shipped in the installed
package (`node_modules/@alexkroman1/aai/AGENT_GUIDE.md`) and its type declarations.

## 1. One declaration for the whole agent: `agent()`

Everything the runtime needs is one object (`agent.ts`):

- **The voice pipeline.** The default is AssemblyAI end to end (speech-to-text → LLM →
  text-to-speech) on a single `ASSEMBLYAI_API_KEY`. Each stage can be swapped alone:
  this project only overrides STT, `assemblyAIStt({ voiceFocus: "off" })`, because the
  board's own front end already does echo cancellation and beamforming. `voice: "jane"` is
  sugar for `tts: assemblyAITts({ voice })`.
- **`greeting`**: the first thing heard, so a new session isn't dead air.
- **`system-prompt.md` and `tools/`** are found by where they sit, not imported. Each
  file in `tools/` is one tool.
- **`builtinTools`**: host-side tools enabled by name: `think`, `open_meteo`,
  `brave_search`, `google_places`, `calculate`, `visit_webpage`, `run_code` (model-written
  JS in a zero-permission Deno sandbox) and `text_me` (SMS via Textbelt). None of them is
  code in this repo.
- **`requiredEnv`**: a deploy refuses to start without these keys, instead of tools
  apologizing on every call.
- **`telephony: ["twilio"]`** (in `caller/agent.ts`): the same agent shape answers a
  phone call instead of a browser or device socket.

`aai dev`, `aai build`, `aai start` and `aai publish` run the same definition locally,
self-hosted, or on the managed platform.

## 2. Tools the model calls: `tool()` and its helpers

`tool({ description, inputSchema, execute })` takes a Zod schema, which is both the JSON
schema the model sees and the validation run before `execute`. The helpers around it keep
tools short and their failures speakable:

- **`toolFailure(message)`** returns an error the model reads and can say, as opposed to
  a throw. `isToolFailure` narrows a result that may be one.
- **`requireSessionClient(ctx, why)`** and **`sessionClientId(ctx)`** give the `?client=`
  id the device connected with, which is the address every later delivery goes to.
  `sessionClientPhone(ctx)` is the phone the client reported.
- **Schema helpers made for models**, such as `clockTime(...)`, a 24-hour, zero-padded
  time whose description tells the model the half it gets wrong ("4:45" for quarter to
  five). `tools/remind_me.ts` uses it so the model passes what was *said* and the code
  does the arithmetic.
- **Speech formatting**: `spokenTime`, `spokenDate` and `isClockTime` (`shared.ts`) turn
  times into what TTS should read: "5 PM", not "17:00" or "five zero zero".
- **`ctx.send(event, data)`** pushes a typed custom event to the client. `tools/stop.ts`
  sends `stop`, and a `declare module` augmentation of `ClientEventMap` types it.

## 3. Work that outlives the conversation: `workflow()`

This is the primitive the agent leans on most. A voice turn has seconds, and a session
hangs up soon after the reply, but a reminder is due tomorrow, research takes minutes, and
a phone call takes as long as it takes. The pattern everywhere is the same: the tool
**starts a durable run and answers at once**, and the run speaks later.

```ts
// shared.ts
export const remind = workflow({ description, input: z.object({ ... }), run: remindFlow });

// tools/remind_me.ts
await ctx.workflows.start(remind, { clientId, text, dueAt }, { key: clientId, label });
```

The run body gets a `WorkflowContext` with journaled, replay-safe operations:

| Primitive | What it gives you | Used in |
| --- | --- | --- |
| `ctx.step(name, fn, { maxAttempts })` | A journaled unit of work: retried on failure, never re-run once it has succeeded, even across a restart | every workflow |
| `ctx.sleep(name, until)` | Park the run until a time, holding no process | `remind.ts` |
| `ctx.poll(name, fn, { everyMs, maxMs, done })` | Check something periodically until it is done or out of time | `call.ts` (Twilio status) |
| `ctx.sayOnClient(name, clientId, notice)` | Synthesize speech and deliver it to a device's inbox, with retries and an idempotent notice id | reminders, calls, research, app jobs |
| `onFailure` | An engine hook that runs once when a run fails for good | `research`, `appJob` |
| `sayFailureOnClient({...})` | A ready-made `onFailure` that says the failure on the speaker, so a promised job never just goes quiet | `research.ts`, `app-job.ts` |

Starting a run has knobs that matter for voice:

- **`key`** groups runs by speaker, so the page can list them and `cancelAll(remind,
  clientId)` can cancel just this speaker's reminders (`tools/cancel_reminders.ts`).
- **`dedupeKey`** makes a repeated start a no-op: `onSessionEnd` uses
  `${sessionId}:${lastEventIndex}`, and the Composio webhook uses the event id, so
  redeliveries don't start second runs.
- **`label`** is what the page's Running panel shows.

Because steps journal by name, the code can change under a run that is in flight. The
comments in `workflows/call.ts` and `workflows/app-job.ts` note where step names were
kept or changed for exactly that reason.

## 4. Talking to a device that isn't in a conversation: the client inbox

A reminder rings long after the session that set it has closed. The SDK gives every
client an **inbox**: an idle socket the device holds open (firmware `inbox.c`, and
`useInbox` in the browser). `clientInbox: { sampleRate: 16_000 }` in `agent.ts` makes
pushed audio arrive at the board's native rate, so the firmware needs no resampler.
`ctx.sayOnClient` delivers to it: a speaker that is unplugged, rebooting or
mid-conversation gets the notice when it can take it, and a redelivery after a lost ack
carries the same id, so the device drops the repeat.

## 5. Step-side helpers (`@alexkroman1/aai/step`)

Inside a step there is no tool `ctx`, so the SDK provides step-scoped equivalents:

- **`stepEnvContext()`, `stepEnv(name)`, `requireStepEnv(name)`**: env and secrets from
  inside a run.
- **`stepGenerateOrFail` / `stepGenerateJsonOrFail`** (`/step-errors`): a one-shot LLM
  call, plain text or schema-checked JSON, with failures classified for the step's retry.
  Used to write the spoken and texted answers and the conversation digests.
- **`stepClientTranscript`**: read a session's turns after it ends (`memorize.ts`).
- **`stepPollUntil`**: wait inside a step, used for mem0's extraction to land.
- **`stepTextOwner`**: the `text_me` rule from a run. The client's phone number is only
  a claim, so it is used only when allow-listed, and otherwise the owner gets the text
  (`workflows/text.ts`).
- **`stepPlaceCall`, `stepCallStatus`, `isCallOver`, `PlaceCallError`**: dial an outbound
  call through Twilio that streams to another aai agent, and track it
  (`workflows/call.ts`). `PlaceCallError.retryable` separates "fix your config" from
  "try again".
- **`stepReport(text)`**: progress the page's Running panel shows while a run works.
- **`throwStepError`**: rethrow with the right retry classification.

## 6. Agents inside runs: `subagent()` and `stepDelegate`

`workflows/app-job.ts` does every app task ("summarize my last 50 emails") by delegating
to a **subagent**: its own system prompt, `expectedOutput`, a `maxSteps` budget, its own
builtins (`run_code`) and its own tools. `stepDelegate(worker, { task })` runs it to
completion inside one step, so the whole agentic loop is journaled as one retryable unit.
Its tools are built per run, closed over the speaker they act for.

## 7. External tools over MCP: `stepMcp` and `mcpToolName`

`stepMcp(servers, { clientId })` opens MCP connections for the length of one step and
hands their tools to a subagent. `mcpToolName("composio", "COMPOSIO_SEARCH_TOOLS")` gives
the name the model sees, so prompts can refer to tools exactly.

## 8. The household's apps: `composio()` (experimental)

`apps.ts` is almost all configuration. The SDK's `composio()` client owns the parts that
are easy to get wrong:

- sessions per user and kind (`voice`, and `background` with the Python workbench),
  persisted through a small `ComposioSessionStore` you supply (Supabase here), and
  recreated once when Composio has lost one;
- `apps.mcpServer({ kind })`, which exposes a session as an MCP server offering only
  `COMPOSIO_MCP_TOOLS`;
- `connectLink`, `execute`, the catalog, and the user's active accounts, for the page;
- **`composioWebhookRoute`** and **`composioTriggerText`**: a verified webhook endpoint
  for trigger events and a compact text rendering of the event for a model to judge. This
  is "tell me when Sam emails" (`routes.ts`, `workflows/app-event.ts`).

## 9. Ready-made workflows: `deepResearchWorkflow` (experimental)

`workflows/research.ts` is the SDK's multi-stage research pipeline (brief, plan, one
researcher per angle, gaps, a second wave, the report) with only this project's prompts,
the researcher's builtins, and a `deliver` hook plugged in. `citedSources` maps the
report's `[n]` citations back to real URLs, so no model retypes a link.

## 10. Session lifecycle hooks

- **`sessionContext({ sessionId, clientId, env, signal })`** runs once per connect and
  returns `instructions` (fixed for the session, so they stay in the cached prompt
  prefix), `historySince` (the SDK replays recent turns verbatim), and `location` (what
  "near me" means for the builtins). The caller agent returns `{ refuse }` to reject any
  session that isn't an approved call before a word is said, and a per-call `greeting`.
- **`onSessionEnd({ sessionId, clientId, workflows, lastEventIndex })`** starts the
  `memorize` run that digests the conversation and feeds mem0.
- **`events`**, e.g. `"user-transcript.committed"` and `"agent-transcript.committed"`,
  stream the transcript turn by turn (`caller/agent.ts`), so a dropped call still has one.

## 11. HTTP for the page: `routes`, `route()` and `clientRunsRoutes`

`routes` in `agent.ts` serves the agent's own JSON API under `/api`:

- **`route({ body, requireClient, handler })`** validates the body with Zod and answers
  400 with the reason. `routeError(status, msg)` does the same from inside a handler.
- **`clientRunsRoutes(options)`** is the whole Running panel's backend: list a speaker's
  runs, keep recently finished ones visible, show progress and failure reasons, and cancel
  only that speaker's own runs.

## 12. The browser client: `@alexkroman1/aai-ui`

The page (`ui/`) is a React app on the SDK's hooks and components:

- `useSession`, `useSessionId`, **`useTapToTalk`** (push to go live, idle and thinking
  hang-up timers, connect timeout), and **`useInbox`** for pushed notices.
- `ConversationView`, `ToolCallRow`, `SessionErrorBanner` for the transcript.
- `useRoute`, `useRouteMutation`, **`useClientRuns`** for the sidebar's API calls.
- `useStoredValue`, `browserClientId`, `createLinkedClient`, `phoneE164` for identity and
  settings.

## 13. Small utilities worth knowing

- `mintDigitCode`, `hashCode`, `codeMatches`: the spoken link code that joins a browser
  to a speaker (`link.ts`).
- `jsonClient`, `HttpError`, `isRecord`, `errorMessage`, `normalizePhone`
  (`/utils`).
- `sendToChannel`, `textbeltChannel`, `TEXTBELT_MAX_MESSAGE_CHARS` (`/channels`).

## 14. Testing a voice agent

The SDK makes a voice agent testable without a microphone, a speaker or a network:

- **Unit** (`@alexkroman1/aai/testing`, `/testing/vitest`): `runTool` with
  `createToolContext({ clientId, workflows })`; `createWorkflowContext({ runSteps })`,
  which records `steps` and `slept`; `installStubWorkflows`, `installStubClientInbox`,
  `installStubSpeech` and `installFetchRoutes`; `createRunSnapshot`; `stubStepMcp`.
- **Config** checks: `expectDeployable(def)` resolves what actually deploys, and
  `expectPromptBuiltinsDeclared` catches a prompt that names a builtin that isn't enabled.
  `virtual:aai/agent` imports the deployed definition, including `tools/` and the prompt.
- **Evals** (`@alexkroman1/aai-runtime/eval`): `describeEval` drives a real session with
  the real runtime and tools, against a live model or `AAI_EVAL_STUB=1` scripted replies.
  `evalNetwork` fakes every backend, `createRecordingWorkflows` records runs instead of
  starting them, and `toolNames`, `toolArgsIn`, `turnCalling` and `customEventsIn` make
  assertions over the turns (`agent.eval.test.ts`).

## The shape it all adds up to

```text
voice turn ──► tool ──► ctx.workflows.start(...) ──► "On it."          (seconds)
                               │
                               ▼
                      durable run: step / sleep / poll / subagent / MCP
                               │
                               ▼
                      ctx.sayOnClient ──► device inbox ──► spoken     (minutes to days)
```

Nearly every feature of the Home Speaker is this loop with a different middle, and the
SDK supplies the ends.
