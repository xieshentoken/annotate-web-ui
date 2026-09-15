/* SymbUI anchor injection as a Vite plugin.
 *
 * This is the delivery wrapper: it runs the Babel plugin from
 * ./babel-plugin-symbui-source.js over the raw source, before Vite's own
 * transforms, and reports real coverage when it is done. The rules still live
 * in ./anchor-core.js.
 *
 *   // vite.config.js
 *   import { createSymbuiAnchorPlugin } from "./plugins/vite-plugin-symbui.mjs";
 *
 *   export default defineConfig({
 *     plugins: [createSymbuiAnchorPlugin()],
 *   });
 *
 * For a Vue project, also hand the template transform to @vitejs/plugin-vue:
 *
 *   import { createVueAnchorTransform } from "./plugins/vue-anchor-transform.mjs";
 *   vue({ template: { compilerOptions: {
 *     nodeTransforms: [createVueAnchorTransform()],
 *   }}})
 *
 * This file is an ES module on purpose, and so is every module it statically
 * imports. Vite bundles `vite.config.mjs` with esbuild into an ES module; a
 * CommonJS `require("path")` anywhere in that graph becomes a shim that throws
 * `Dynamic require of "path" is not supported` before the config loads. The
 * only external module touched here is `@babel/core`, which is loaded lazily and
 * from a configurable base.
 *
 * Options:
 *   root            project root. Defaults to Vite's `config.root`.
 *   resolveFrom     extra directory to resolve `@babel/core` from. Only needed
 *                   when the install is hoisted outside the project root.
 *   include         RegExp of module ids to transform. Default: /\.[jt]sx?$/
 *   exclude         RegExp of module ids to skip, in addition to node_modules.
 *   apply           "serve" (default, dev only) or "build" or "both".
 *   parserPlugins   Babel syntax plugins. Default ["jsx", "typescript"].
 *   report          set false to silence the coverage summary.
 *   ...plus every anchor-core option: roots, excludeSegments, mode,
 *   emitComponent, emitColumn, skipTags.
 */

import { createRequire } from "node:module";

import core from "./anchor-core.js";
import createVueAnchorTransform from "./vue-anchor-transform.mjs";
import babelAnchorPlugin from "./babel-plugin-symbui-source.js";

const DEFAULT_INCLUDE = /\.[jt]sx?$/;

/* A loose pre-filter. It must never produce a false negative — a missed JSX
 * file is a silent hole in the inventory — so it only asks whether the source
 * contains a `<` at all.
 */
const MAYBE_JSX = /</;

/* Reasons that mean "this is working as designed". Everything else is a signal
 * that the plugin is misconfigured, and the summary says so out loud.
 */
const EXPECTED_REASONS = [
  "component-element",
  "not-inventoried",
  "already-annotated",
  "symbui-host",
];

/* `@babel/core` is resolved from several bases on purpose. In a normal project
 * it sits in the project's own node_modules; in a hoisted monorepo it sits at
 * the workspace root instead; and when this plugin is symlinked into a project
 * the plain `require` chain may not reach either.
 */
function loadBabel(bases) {
  const attempts = [];

  for (const base of bases) {
    if (!base) continue;
    attempts.push(() => {
      const from = createRequire(core.resolvePath(base, "noop.js"));
      return from("@babel/core");
    });
  }

  attempts.push(() => {
    const from = createRequire(import.meta.url);
    return from("@babel/core");
  });

  const failures = [];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (error) {
      /* Keep every failure. A single generic message here is the difference
       * between "it does not work" and "it looked in these four places".
       */
      failures.push(String((error && error.message) || error));
    }
  }

  const error = new Error(
    "@babel/core could not be resolved from any of: " +
      bases.filter(Boolean).join(", ") +
      ".\nInstall it, pass `resolveFrom`, or wire plugins/babel-plugin-symbui-source.js " +
      "into the Babel config you already run.\nTried: " +
      failures.join(" | "),
  );
  error.code = "SYMBUI_NO_BABEL";
  throw error;
}

function stripQuery(id) {
  const query = id.indexOf("?");
  return query >= 0 ? id.slice(0, query) : id;
}

function emptyStats() {
  return { injected: 0, files: 0, skipped: {} };
}

function mergeStats(target, stats) {
  target.injected += stats.injected;
  for (const reason of Object.keys(stats.skipped)) {
    target.skipped[reason] = (target.skipped[reason] || 0) + stats.skipped[reason];
  }
}

export function formatSummary(stats) {
  if (stats.files === 0) {
    return "symbui: no modules matched. Check `include`/`exclude`; nothing was annotated.";
  }
  const parts = [`symbui: ${stats.injected} anchors across ${stats.files} modules`];
  const expected = [];
  const worrying = [];
  for (const reason of Object.keys(stats.skipped).sort()) {
    const entry = `${reason} ${stats.skipped[reason]}`;
    if (EXPECTED_REASONS.includes(reason)) expected.push(entry);
    else worrying.push(entry);
  }
  if (expected.length) parts.push(`expected skips: ${expected.join(", ")}`);
  if (worrying.length) {
    parts.push(
      `UNEXPECTED skips: ${worrying.join(", ")} — anchors are missing for reasons that usually mean a misconfigured root`,
    );
  }
  return parts.join(" | ");
}

export function createSymbuiAnchorPlugin(options) {
  const settings = options || {};
  const stats = emptyStats();
  let reportTimer = null;
  let announced = false;

  /* State lives in the closure, not on `this`. Hook `this` binding is a Vite
   * implementation detail that changes between versions, and when a config is
   * bundled into an ES module a lost receiver turns `this.x = y` into a
   * TypeError before the dev server even starts. A closure cannot lose its
   * receiver.
   */
  let projectRoot = null;
  let babel = null;

  function report(logger) {
    if (settings.report === false) return;
    (logger || console.log)(formatSummary(stats));
  }

  function scheduleReport() {
    if (settings.report === false) return;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      reportTimer = null;
      report();
    }, 1200);
    /* A pending timer must not hold the process open. */
    if (reportTimer && typeof reportTimer.unref === "function") reportTimer.unref();
  }

  return {
    name: "symbui-anchor",
    /* `pre` matters: Vite's own plugins and @vitejs/plugin-react would otherwise
     * have already erased the JSX, and with it every line number we need.
     */
    enforce: "pre",
    apply: settings.apply === "both" ? undefined : settings.apply || "serve",

    configResolved(config) {
      projectRoot = settings.root || config.root;
      /* Throws with the list of places it looked, rather than returning null and
       * leaving the caller to guess.
       */
      babel = loadBabel([settings.resolveFrom, projectRoot, process.cwd()]);
    },

    transform(code, id) {
      if (!MAYBE_JSX.test(code)) return null;
      if (!babel) return null;

      const file = stripQuery(id);
      if (!DEFAULT_INCLUDE.test(file)) return null;
      if (file.includes("\u0000")) return null;
      if (file.includes("node_modules")) return null;
      if (settings.exclude && settings.exclude.test(file)) return null;
      if (settings.include && !settings.include.test(file)) return null;

      let result;
      try {
        result = babel.transformSync(code, {
          filename: file,
          /* The plugin only adds attributes; syntax is left exactly as written
           * so Vite's esbuild pass still compiles the TS and JSX afterwards.
           */
          configFile: false,
          babelrc: false,
          sourceMaps: true,
          parserOpts: { plugins: settings.parserPlugins || ["jsx", "typescript"] },
          plugins: [
            [
              babelAnchorPlugin,
              {
                root: projectRoot,
                roots: settings.roots,
                exclude: settings.excludeSegments,
                mode: settings.mode,
                emitComponent: settings.emitComponent,
                emitColumn: settings.emitColumn,
                skipTags: settings.skipTags,
              },
            ],
          ],
        });
      } catch (error) {
        error.message =
          "symbui-anchor could not parse " +
          file +
          ": " +
          error.message +
          "\nPass `parserPlugins` for unusual syntax, or wire the Babel plugin into your own Babel config instead.";
        throw error;
      }

      if (!announced) {
        announced = true;
        console.log("symbui: anchoring development builds (dev only, stripped in production)");
      }

      const fileStats = result.metadata && result.metadata.symbuiAnchors;
      if (fileStats) {
        stats.files += 1;
        mergeStats(stats, fileStats);
        scheduleReport();
      }

      return result.code === code ? null : { code: result.code, map: result.map };
    },

    configureServer(server) {
      if (server.httpServer) server.httpServer.once("close", () => report());
    },

    buildEnd(error) {
      if (error) return;
      report();
    },

    /* Exposed for tests and for a host that wants the numbers in its own UI. */
    api: {
      stats() {
        return JSON.parse(JSON.stringify(stats));
      },
      summary() {
        return formatSummary(stats);
      },
    },
  };
}

export { createVueAnchorTransform, core as anchorCore };
export default createSymbuiAnchorPlugin;
