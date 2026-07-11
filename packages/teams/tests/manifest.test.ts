import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { TEAMS_AGENT_TOOLS, TEAMS_AGENT_TOOL_DECLARATIONS } from "../src/agent-tool-declarations.js";

/**
 * Regression guard for the "agent can't see post_to_channel" bug: the host advertises
 * agent tools to agents ONLY from `manifest.tools`. A worker-side `ctx.tools.register`
 * installs a handler but does NOT advertise the tool. So every agent-callable tool MUST be
 * declared in the manifest AND wired at runtime — these tests lock the two together.
 */

// The complete set of Teams agent tools. Adding a tool here forces both the manifest
// declaration and a runtime handler to exist (asserted below), or the suite fails.
const EXPECTED_TOOL_NAMES = [
  "escalate_to_human",
  "ask_person",
  "list_open_asks",
  "cancel_ask",
  "post_to_channel",
  "get_channel_responses",
  "list_channel_members",
] as const;

describe("teams manifest agent tools", () => {
  it("declares every agent tool in manifest.tools (host advertises only manifest tools)", () => {
    const declared = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(declared).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("manifest.tools is the single-source declaration list (no drift copy)", () => {
    expect(manifest.tools).toBe(TEAMS_AGENT_TOOL_DECLARATIONS);
    expect(Object.keys(TEAMS_AGENT_TOOLS)).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });

  it("every declared tool has a usable name, description, and object parametersSchema", () => {
    for (const tool of manifest.tools ?? []) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.displayName && tool.displayName.length).toBeTruthy();
      expect(tool.description && tool.description.length).toBeGreaterThan(10);
      expect((tool.parametersSchema as { type?: string } | undefined)?.type).toBe("object");
    }
  });

  it("requires agent.tools.register capability (needed to also wire the runtime handlers)", () => {
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("wires a runtime ctx.tools.register handler for every declared tool (manifest<->worker lock)", () => {
    // Source-level guard: the worker registers each tool via TEAMS_AGENT_TOOLS.<key>.name, so a
    // declared tool that lost its handler (or vice versa) fails here without booting the worker.
    const workerSrc = readFileSync(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8");
    for (const key of Object.keys(TEAMS_AGENT_TOOLS)) {
      expect(workerSrc).toContain(`TEAMS_AGENT_TOOLS.${key}.name`);
      expect(workerSrc).toContain(`toolRuntimeDecl(TEAMS_AGENT_TOOLS.${key})`);
    }
    // And no stray string-literal registrations remain (which would bypass the shared source).
    expect(workerSrc).not.toMatch(/ctx\.tools\.register\(\s*"/);
  });
});
