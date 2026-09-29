# Agent instructions

This is an [aai](https://github.com/alexkroman/agent) voice-agent project. An agent is a directory
containing `agent.ts`; the `aai` CLI bundles it and deploys it.

## Read the SDK guide before writing agent code

The complete authoring guide ships inside the installed package:

```text
node_modules/@alexkroman1/aai/AGENT_GUIDE.md
```

Read it with your file tools. It is version-matched by construction — it lives
in the same tarball as the `@alexkroman1/aai` this project resolved, so it
cannot describe a different release than the one being imported. Prefer it over
anything remembered about the SDK, and over anything in this file.

The types are the second source of truth: the shipped declarations are in
`node_modules/@alexkroman1/aai/dist/`. When the guide and the types disagree,
the types are what the compiler enforces.

## Commands

```sh
npm run dev            # Run locally on http://localhost:3000
npm test               # This project's suite, minus the evals
npm run test:agent     # Just agent.test.ts, via the CLI
npm run eval           # Drive a real session against a live model (spends money)
npm run build          # Bundle the agent
npm start              # Build, then self-host on http://127.0.0.1:3000
npm run publish:agent  # Publish to the managed platform
```

The `aai` CLI is a devDependency, so it is in `node_modules/.bin` rather than
on `PATH`: reach it through these scripts or with `npx aai <command>`.

## Project-specific notes

<!-- Add conventions, gotchas and decisions for THIS agent below. -->
