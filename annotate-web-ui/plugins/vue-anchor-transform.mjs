/* SymbUI anchor injection for Vue single-file-component templates.
 *
 * A `nodeTransform` for `@vue/compiler-core` / `@vue/compiler-dom` /
 * `@vue/compiler-sfc`. Like the Babel plugin, it decides nothing on its own:
 * it builds a descriptor and defers to `planInjection` in ./anchor-core.js.
 *
 * This file is an ES module on purpose. Vite bundles `vite.config.mjs` with
 * esbuild into an ES module, and a CommonJS `require("path")` anywhere in that
 * graph becomes a shim that throws `Dynamic require of "path" is not supported`
 * before the config even loads. Nothing here requires anything external.
 *
 * Wire it in through whatever owns the template compiler:
 *
 *   // vite.config.js
 *   import vue from "@vitejs/plugin-vue";
 *   import { createVueAnchorTransform } from "./plugins/vue-anchor-transform.mjs";
 *
 *   export default defineConfig({
 *     plugins: [vue({
 *       template: {
 *         compilerOptions: {
 *           nodeTransforms: [createVueAnchorTransform({ root: __dirname })],
 *         },
 *       },
 *     })],
 *   });
 *
 *   // vue-loader / @vue/compiler-sfc
 *   compileTemplate({ source, filename, compilerOptions: {
 *     nodeTransforms: [createVueAnchorTransform({ root: __dirname })],
 *   }})
 *
 * Why the transform runs on *enter* and returns nothing: user `nodeTransforms`
 * are appended after the built-in ones, and `transformElement` — the pass that
 * actually reads `node.props` and emits them into the render function — is an
 * `exit` callback. Pushing the attribute during enter means the built-in exit
 * sees it. Returning an exit callback here would be too late.
 *
 * Options mirror the Babel plugin:
 *   root, roots, exclude, mode, componentName, emitComponent, emitColumn
 */

import core from "./anchor-core.js";

/* @vue/compiler-core NodeTypes, spelled out so the transform needs no imports.
 * Verified against Vue 3.x; the runtime guards below re-check the shape rather
 * than trusting these numbers blindly.
 */
const NODE_ELEMENT = 1;
const NODE_TEXT = 2;
const NODE_ATTRIBUTE = 6;

/* Vue tags its own overlay scaffolding the way the runtime probe expects. */
const SKIP_ATTRIBUTES = ["data-symbui-skip", "data-symbui-host"];

function attributeNames(node) {
  const names = [];
  const props = (node && node.props) || [];
  for (const prop of props) {
    if (prop && prop.type === NODE_ATTRIBUTE && typeof prop.name === "string") {
      names.push(prop.name);
    }
  }
  return names;
}

function pointFrom(loc) {
  const start = loc && loc.start ? loc.start : null;
  return {
    line: start && start.line ? start.line : 1,
    column: start && start.column ? start.column : 0,
    offset: start && typeof start.offset === "number" ? start.offset : 0,
  };
}

/* Build the exact AST shape the template parser produces for a static
 * attribute. Anything less complete and codegen either drops the attribute or
 * trips a sourcemap assertion.
 */
function makeAttribute(name, value, elementLoc) {
  const point = pointFrom(elementLoc);
  const loc = { start: point, end: point, source: "" };
  return {
    type: NODE_ATTRIBUTE,
    name,
    nameLoc: loc,
    value: { type: NODE_TEXT, content: value, loc },
    loc,
  };
}

/* A component's own file name is the most reliable name available at template
 * compile time; `index.vue` borrows its directory name, which is the
 * convention Vue projects already follow.
 */
export function basenameComponent(filename) {
  if (!filename) return "";
  const base = core.pathBase(filename).replace(/\.vue$/, "");
  if (!base || base === "index") {
    const parent = core.pathBase(core.pathDir(filename));
    if (parent && parent !== "." && parent !== "/") return parent;
  }
  return base;
}

/* The framework's own classification beats any heuristic: `tagType` is set by
 * the parser and already accounts for `<component :is>`, `<slot>`,
 * `<template>`, and anything registered through `isCustomElement`.
 */
function resolveHost(node, context) {
  if (typeof node.tagType === "number") return node.tagType === 0;
  if (context && typeof context.isNativeTag === "function") {
    try {
      return context.isNativeTag(node.tag) === true;
    } catch (error) {
      return core.isHostTag(node.tag);
    }
  }
  return core.isHostTag(node.tag);
}

function filenameOf(context) {
  if (context && typeof context.filename === "string" && context.filename) return context.filename;
  const options = (context && context.options) || {};
  if (typeof options.filename === "string" && options.filename) return options.filename;
  return "";
}

export function createVueAnchorTransform(options) {
  const settings = options || {};

  function symbuiVueAnchorTransform(node, context) {
    if (!node || node.type !== NODE_ELEMENT || typeof node.tag !== "string") return;
    if (!Array.isArray(node.props)) return;

    const filename = filenameOf(context);
    if (!filename) return;

    const names = attributeNames(node);
    const skipRequested = SKIP_ATTRIBUTES.some((name) => names.includes(name));

    const loc = node.loc && node.loc.start;

    const plan = core.planInjection(
      {
        tag: node.tag,
        host: resolveHost(node, context),
        file: core.isAbsolutePath(filename)
          ? filename
          : core.resolvePath(process.cwd(), filename),
        line: loc ? loc.line : null,
        column: loc ? loc.column : null,
        component: settings.componentName || basenameComponent(filename),
        mode: settings.mode,
        /* Zero-config works when the build runs from the project root, which is
         * the normal case for Vite, webpack, and vue-cli alike. A root that
         * turns out to be wrong surfaces as a loud SYMBUI_NO_ROOT rather than
         * as silent non-injection.
         */
        root: settings.root || process.cwd(),
        roots: settings.roots,
        attributes: names,
        insideSymbuiHost: skipRequested,
      },
      settings,
    );

    if (typeof context.onError === "function" && plan.reason === "outside-root") {
      /* A silent no-op here is the single most confusing failure mode: the
       * plugin is installed, the build succeeds, and nothing is annotated.
       */
      context.onError({
        code: "SYMBUI_NO_ROOT",
        message:
          "SymbUI could not make " +
          filename +
          " relative to any configured root, so no anchor was injected. " +
          "Pass `root` to createVueAnchorTransform().",
        loc: node.loc,
      });
      return;
    }

    if (!plan.inject) return;

    for (const entry of plan.attributes) {
      node.props.push(makeAttribute(entry.name, entry.value, node.loc));
    }
  }

  symbuiVueAnchorTransform.symbui = { options: settings };

  return symbuiVueAnchorTransform;
}

export default createVueAnchorTransform;
export { NODE_ATTRIBUTE, NODE_TEXT };
