/* Tests for the Vite delivery wrapper.
 *
 * The wrapper is exercised without Vite itself: `configResolved` and `transform`
 * are called with the plugin object as `this`, which is exactly how Vite binds
 * its plugin context. That keeps the test fast while still covering the wiring,
 * the id filtering, and the coverage summary.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const requireLocal = createRequire(import.meta.url);
void requireLocal;

const { createSymbuiAnchorPlugin, createVueAnchorTransform, formatSummary } = await import(
  "../annotate-web-ui/plugins/vite-plugin-symbui.mjs"
);

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const CANDIDATES = [
  process.env.SYMBUI_TEST_MODULES,
  path.join(REPO_ROOT, "node_modules"),
  REPO_ROOT,
].filter(Boolean);

const MODULES = (() => {
  for (const directory of CANDIDATES) {
    try {
      createRequire(path.join(directory, "noop.js"))("@babel/core");
      return directory;
    } catch (error) {
      /* keep looking */
    }
  }
  return null;
})();

const skip = MODULES ? false : "install @babel/core, then set SYMBUI_TEST_MODULES";

const ROOT = "/repo";

function boot(options = {}) {
  const plugin = createSymbuiAnchorPlugin({
    report: false,
    resolveFrom: MODULES,
    ...options,
  });
  plugin.configResolved.call(plugin, { root: ROOT });
  return plugin;
}

function run(plugin, code, id) {
  return plugin.transform.call(plugin, code, id);
}

test("vite: a jsx module is transformed and keeps its anchors", { skip }, () => {
  const plugin = boot();
  const result = run(
    plugin,
    `export function Card() {\n  return <article className="card" />;\n}`,
    `${ROOT}/src/Card.tsx`,
  );
  assert.ok(result, "the module should have been transformed");
  assert.match(result.code, /data-ui-source="src\/Card\.tsx:2:9"/);
  assert.match(result.code, /data-component="Card"/);
  assert.ok(result.map, "a source map must be returned");
});

test("vite: the transform is skipped for modules without jsx", { skip }, () => {
  const plugin = boot();
  const result = run(plugin, `export const answer = 1 < 2;`, `${ROOT}/src/util.ts`);
  assert.equal(result, null);
});

test("vite: dependencies are never transformed", { skip }, () => {
  const plugin = boot();
  const result = run(
    plugin,
    `export function Card() { return <div />; }`,
    `${ROOT}/node_modules/lib/Card.tsx`,
  );
  assert.equal(result, null);
});

test("vite: a vue file is left to the template transform", { skip }, () => {
  const plugin = boot();
  const result = run(
    plugin,
    `export default { render() { return <div />; } }`,
    `${ROOT}/src/Card.vue?vue&type=script`,
  );
  assert.equal(result, null, ".vue modules are handled by createVueAnchorTransform");
});

test("vite: a query suffix does not defeat the extension filter", { skip }, () => {
  const plugin = boot();
  const result = run(plugin, `export const x = <div />;`, `${ROOT}/src/Card.tsx?used`);
  assert.ok(result, "the id should be matched on its path, not its query");
});

test("vite: a virtual module is skipped", { skip }, () => {
  const plugin = boot();
  assert.equal(run(plugin, `export const x = <div />;`, `\u0000virtual:card.tsx`), null);
});

test("vite: an explicit exclude pattern wins", { skip }, () => {
  const plugin = boot({ exclude: /\/legacy\// });
  const result = run(plugin, `export const x = <div />;`, `${ROOT}/legacy/Card.tsx`);
  assert.equal(result, null);
});

test("vite: coverage statistics accumulate across modules", { skip }, () => {
  const plugin = boot();
  run(plugin, `export function A() { return <div />; }`, `${ROOT}/src/A.tsx`);
  run(plugin, `export function B() { return <span />; }`, `${ROOT}/src/B.tsx`);
  const stats = plugin.api.stats();
  assert.equal(stats.injected, 2);
  assert.equal(stats.files, 2);
  const summary = plugin.api.summary();
  assert.match(summary, /2 anchors across 2 modules/);
});

test("vite: a file outside the root is reported as an unexpected skip", { skip }, () => {
  const plugin = boot();
  run(plugin, `export function A() { return <div />; }`, `/elsewhere/A.tsx`);
  const summary = plugin.api.summary();
  assert.match(summary, /UNEXPECTED skips: outside-root/);
});

test("vite: expected skips are listed separately from unexpected ones", { skip }, () => {
  const plugin = boot();
  run(
    plugin,
    `export function A() { return <div><Card /></div>; }`,
    `${ROOT}/src/A.tsx`,
  );
  const summary = plugin.api.summary();
  assert.match(summary, /expected skips: component-element 1/);
  assert.ok(!/UNEXPECTED/.test(summary), `unexpected warning in: ${summary}`);
});

test("vite: a run that matched nothing says so instead of reporting zero anchors", { skip }, () => {
  const plugin = boot();
  assert.match(plugin.api.summary(), /no modules matched/);
});

test("vite: unparsable syntax produces an actionable error", { skip }, () => {
  const plugin = boot();
  assert.throws(
    () => run(plugin, `export function A() { return <div */; }`, `${ROOT}/src/A.tsx`),
    /could not parse [\s\S]*Pass `parserPlugins`/,
  );
});

test("vite: the vue transform is re-exported for the vue plugin config", () => {
  const transform = createVueAnchorTransform({ root: ROOT });
  assert.equal(typeof transform, "function");
  assert.equal(transform.symbui.options.root, ROOT);
  assert.equal(typeof formatSummary, "function");
});
