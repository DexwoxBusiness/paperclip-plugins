import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * PCLIP-23 AC #2: the bot codebase must have ZERO botbuilder / Bot Framework SDK
 * dependencies — the Agents SDK only. The Bot Framework SDK reached end of support in
 * Dec 2025; this guard fails CI if a forbidden package is ever (re)introduced.
 *
 * Scope: the WHOLE monorepo (root package.json + every packages/*), not just the teams
 * package — a forbidden dep introduced anywhere in the workspace would still ship in
 * "the bot codebase" (shared deps, transitive workspace links).
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

/** Repo root = two levels up from packages/teams. */
function repoRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(new URL("./", import.meta.url)))));
}

/** Every package.json in the workspace: root + each packages/* dir. */
function allPackageJsons(): string[] {
  const root = repoRoot();
  const found: string[] = [];
  const rootPkg = join(root, "package.json");
  if (existsSync(rootPkg)) found.push(rootPkg);
  const pkgsDir = join(root, "packages");
  if (existsSync(pkgsDir)) {
    for (const entry of readdirSync(pkgsDir)) {
      const p = join(pkgsDir, entry, "package.json");
      if (existsSync(p) && statSync(p).isFile()) found.push(p);
    }
  }
  return found;
}

describe("no Bot Framework SDK dependencies (PCLIP-23 AC #2)", () => {
  it("no workspace package declares a botbuilder/botframework package", () => {
    const offenders: Array<{ pkg: string; dep: string }> = [];
    for (const pkgPath of allPackageJsons()) {
      for (const dep of depsOf(pkgPath)) {
        if (FORBIDDEN.some((re) => re.test(dep))) offenders.push({ pkg: pkgPath, dep });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the teams package uses the Microsoft 365 Agents SDK, not the retired Bot Framework SDK", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const msBotDeps = depsOf(pkgPath).filter((n) => /agents-hosting|botbuilder|botframework/i.test(n));
    expect(msBotDeps.length).toBeGreaterThan(0); // it DOES depend on the Agents SDK
    for (const dep of msBotDeps) {
      expect(dep.startsWith("@microsoft/agents-")).toBe(true);
    }
  });
});
