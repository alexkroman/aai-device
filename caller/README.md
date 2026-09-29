# caller

A voice agent built with [aai](https://github.com/alexkroman/agent).

## Getting started

```sh
pnpm install      # Install dependencies
pnpm run dev      # Run locally on http://localhost:3000 (opens browser)
```

The `aai` CLI is a devDependency of this project, so it lives in
`node_modules/.bin` rather than on your `PATH`. Run it through pnpm
(`pnpm run dev`, `pnpm run test`, `pnpm run build`) or with `pnpm exec aai <command>`.
Installing it globally (`npm i -g @alexkroman1/aai-cli`) also works, and is
what the project docs assume.

### The one key local development needs

The default pipeline (speech-to-text → LLM → text-to-speech) runs on a single
AssemblyAI key. **Any one of these is enough, and the first two need no aai
account** — nothing about running this agent locally is gated on one:

1. Put `ASSEMBLYAI_API_KEY=<your key>` in `.env` (this project's `.env.example`
   documents it, and it is the same file `aai publish` uploads as secrets).
2. Or export it in your shell: `export ASSEMBLYAI_API_KEY=<your key>`.
3. Or run `pnpm exec aai login`, and `pnpm run dev` will use your account's key.

Get a key at <https://www.assemblyai.com/dashboard>.

## Publishing

Publishing (and the studio it syncs to) is the one part that does need an
account:

```sh
pnpm exec aai login    # Link your account — once per machine
pnpm run publish:agent # Publish to production (and sync to the studio)
```

You can also run this agent as a plain Node server, with no aai account and
nothing managed:

```sh
pnpm run start         # Builds, then serves on http://127.0.0.1:3000
```

## Secrets

Access secrets in your agent via `ctx.env.MY_KEY`.

**Local development** — add secrets to `.env` (auto-loaded by `aai dev`):

```sh
ALPHA_VANTAGE_KEY=sk-abc123
MY_API_KEY=secret-value
```

**Production** — set secrets on the server:

```sh
pnpm exec aai secret put MY_KEY# Set a secret (prompts for value)
pnpm exec aai secret list    # List secret names
pnpm exec aai secret delete MY_KEY# Remove a secret
```

