import { defineAgentTestConfig } from "@alexkroman1/aai/testing/vite";

// The agent plugin (`virtual:aai/agent`), `globals: true` and a pinned reporter,
// each argued for in the SDK. AAI_DEV_SOURCE=1 resolves the linked SDK from src/.
export default defineAgentTestConfig();
