import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * PCLIP-23 AC #2: the bot codebase must have ZERO botbuilder / Bot Framework SDK
 * dependencies — the Agents SDK only. The Bot Framework SDK reached end of support in
 * Dec 2025; this guard fails CI if a forbidden package is ever (re)introduced.
 */
const FORBIDDEN = [
  /^botbuilder(-.*)?$/i, // botbuilder, botbuilder-core, botbuilder-dialogs, ...
  /^botframework-.*/i, // botframework-connector, botframework-schema, ...
  /^adaptive-expressions$/i, // Bot Framework SDK companion
];

function depsOf(pkgJsonPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, Record<string, string> | undefined>;
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

describe("no Bot Framework SDK dependencies (PCLIP-23 AC #2)", () => {
  it("the teams package declares no botbuilder/botframework packages", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const offenders = depsOf(pkgPath).filter((name) => FORBIDDEN.some((re) => re.test(name)));
    expect(offenders).toEqual([]);
  });

  it("depends on the Microsoft 365 Agents SDK, not the retired Bot Framework SDK", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const names = depsOf(pkgPath);
    // Every Microsoft bot/agent dependency must be under the @microsoft/agents-* scope.
    const msBotDeps = names.filter((n) => /agents-hosting|botbuilder|botframework/i.test(n));
    for (const dep of msBotDeps) {
      expect(dep.startsWith("@microsoft/agents-")).toBe(true);
    }
  });
});
