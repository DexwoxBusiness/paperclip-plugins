import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { TOOL_NAMES } from "../src/constants.js";

/**
 * PCLIP-3 AC #5: all five agent tools are declared in the manifest, and their
 * declared required params match what the handlers (agent-tools.ts) read. This
 * guards against manifest/handler drift (a handler requiring a param the schema
 * doesn't declare, or vice-versa).
 */
const EXPECTED_REQUIRED: Record<string, string[]> = {
  [TOOL_NAMES.getWorkItem]: ["id"],
  [TOOL_NAMES.searchWorkItems]: [],
  [TOOL_NAMES.createWorkItem]: ["projectId", "name"],
  [TOOL_NAMES.addComment]: ["id", "commentHtml"],
  [TOOL_NAMES.updateState]: ["id", "state"],
};

describe("manifest agent-tool declarations (PCLIP-3 AC #5)", () => {
  const byName = new Map((manifest.tools ?? []).map((t) => [t.name, t]));

  it("declares all five agent tools", () => {
    for (const name of Object.values(TOOL_NAMES)) {
      expect(byName.has(name), `missing tool declaration: ${name}`).toBe(true);
    }
  });

  it("each tool has a displayName, description and an object parametersSchema", () => {
    for (const name of Object.values(TOOL_NAMES)) {
      const d = byName.get(name)!;
      expect(d.displayName, name).toBeTruthy();
      expect(d.description, name).toBeTruthy();
      expect((d.parametersSchema as { type?: string }).type).toBe("object");
    }
  });

  it("required params match the handler expectations (prevents schema drift)", () => {
    for (const [name, required] of Object.entries(EXPECTED_REQUIRED)) {
      const schema = byName.get(name)!.parametersSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect((schema.required ?? []).slice().sort(), name).toEqual(required.slice().sort());
      for (const key of required) {
        expect(schema.properties?.[key], `${name}.${key} must be a declared property`).toBeDefined();
      }
    }
  });
});
