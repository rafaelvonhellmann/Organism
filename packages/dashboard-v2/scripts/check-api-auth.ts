#!/usr/bin/env tsx
/**
 * API auth coverage check for dashboard-v2.
 *
 * Run: npx tsx packages/dashboard-v2/scripts/check-api-auth.ts
 * Or add to package.json scripts: "check:auth": "tsx scripts/check-api-auth.ts"
 *
 * Exits non-zero if any route file exports a GET/POST/PUT/DELETE/PATCH handler
 * without calling requireAuth(). Add intentional exceptions to UNPROTECTED_ROUTES.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Routes intentionally unprotected — document WHY.
const UNPROTECTED_ROUTES: Record<string, string> = {
  "src/app/api/auth/route.ts": "Auth endpoint itself — no token exists yet",
  "src/app/api/_template/route.ts": "Template file — not a live route",
};

const AUTH_PATTERN = /requireAuth\s*\(/;
const HTTP_METHODS = /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/;

function walkRoutes(dir: string, base: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = join(base, entry).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) {
      walkRoutes(full, rel, results);
    } else if (entry === "route.ts" || entry === "route.js") {
      results.push(rel);
    }
  }
  return results;
}

import { fileURLToPath } from "url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");
const apiDir = join(projectRoot, "src/app/api");
const routes = walkRoutes(apiDir, "src/app/api");

const unguarded: string[] = [];

for (const rel of routes) {
  if (UNPROTECTED_ROUTES[rel]) continue;
  const content = readFileSync(join(projectRoot, rel), "utf-8");
  if (!HTTP_METHODS.test(content)) continue;
  if (!AUTH_PATTERN.test(content)) {
    unguarded.push(rel);
  }
}

// Check for stale exceptions
const stale: string[] = [];
for (const rel of Object.keys(UNPROTECTED_ROUTES)) {
  try {
    statSync(join(projectRoot, rel));
  } catch {
    stale.push(rel);
  }
}

if (stale.length > 0) {
  console.error("\n[auth-check] Stale UNPROTECTED_ROUTES entries (file no longer exists):");
  stale.forEach((r) => console.error(`  • ${r}`));
  console.error("Remove them from the exception list in scripts/check-api-auth.ts\n");
}

if (unguarded.length > 0) {
  console.error("\n[auth-check] FAIL — Routes missing requireAuth() guard:");
  unguarded.forEach((r) => console.error(`  • ${r}`));
  console.error(
    "\nEither add requireAuth() to the route, or add it to UNPROTECTED_ROUTES with a reason.\n"
  );
  process.exit(1);
}

if (stale.length > 0) process.exit(1);

console.log(`[auth-check] PASS — all ${routes.length} route(s) are guarded.`);
