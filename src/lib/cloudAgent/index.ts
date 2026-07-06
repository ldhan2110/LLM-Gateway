export * from "./types.ts";
export * from "./baseAgent.ts";
export * from "./registry.ts";
export * from "./db.ts";

import { createCloudAgentTaskTable } from "./db.ts";

createCloudAgentTaskTable().catch((err) => {
  console.warn("[cloudAgent] Failed to initialize task table:", err?.message);
});
