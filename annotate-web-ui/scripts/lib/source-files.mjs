/* Which files under a repository are worth indexing.
 *
 * Shared by `build-change-spec.mjs` (the legacy session path) and
 * `consolidate-review.mjs` (the round-based path). Two copies of "what counts
 * as source" would drift apart, and the drift would be silent — the anchor
 * injector already learned that with its skip-tag list.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
]);

export const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".symbui",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

/* A generated bundle can be tens of megabytes and would blow the parse budget
 * without ever being the file an agent should edit. */
export const MAX_FILE_BYTES = 1_500_000;
export const MAX_FILES = 5000;

export async function collectSourceFiles(root) {
  const files = [];
  const queue = [root];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !entry.name.startsWith(".env")) {
        if (entry.isDirectory()) continue;
      }
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const info = await stat(absolute);
      if (info.size <= MAX_FILE_BYTES) files.push(absolute);
    }
  }

  return files;
}
