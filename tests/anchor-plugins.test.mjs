/* End-to-end tests for the build-time anchor injectors.
 *
 * These run the real compilers rather than asserting on hand-built ASTs, so a
 * plugin that produces a plausible-looking node the compiler then silently
 * drops is caught here and nowhere else. Running them for real already caught
 * one: a Vue `<template>` wrapper parses as an ordinary host element and was
 * being annotated even though the runtime probe never inventories it.
 *
 * `@babel/core` and `@vue/compiler-dom` are test-only dependencies and are
 * deliberately NOT declared by the skill, which ships zero runtime deps. Point
 * the harness at a directory that has them:
 *
 *   SYMBUI_TEST_MODULES=/path/to/node_modules \
 *     node --test tests/anchor-plugins.test.mjs
 *
 * Without them the suite reports as skipped instead of failing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = "/repo";

/* Optional test-only dependencies are never declared by the skill, so the
 * harness has to be told where they are. Resolution order: an explicit
 * `SYMBUI_TEST_MODULES`, then a normal `npm install` in this repository, then
 * the repository root itself. Never a path from one developer's machine. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const CANDIDATES = [
  process.env.SYMBUI_TEST_MODULES,
  path.join(REPO_ROOT, "node_modules"),
  REPO_ROOT,
].filter(Boolean);

function loadModules() {
  for (const directory of CANDIDATES) {
    try {
      const requireFrom = createRequire(path.join(directory, "noop.js"));
      return {
        babel: requireFrom("@babel/core"),
        compiler: requireFrom("@vue/compiler-dom"),
      };
    } catch (error) {
      /* Try the next candidate. */
    }
  }
  return null;
}

const modules = loadModules();
const skip = modules
  ? false
  : "install @babel/core and @vue/compiler-dom, then set SYMBUI_TEST_MODULES";

const requireLocal = createRequire(import.meta.url);
const core = requireLocal("../annotate-web-ui/plugins/anchor-core.js");
const babelPlugin = requireLocal("../annotate-web-ui/plugins/babel-plugin-symbui-source.js");

/* The Vue transform is an ES module because Vite bundles configs as ESM, so it
 * has to come in through `import()` rather than `require()`.
 */
const { createVueAnchorTransform } = await import(
  "../annotate-web-ui/plugins/vue-anchor-transform.mjs"
);

/* JSX emits `data-ui-source="..."`, Vue emits `"data-ui-source": "..."`. Both
 * shapes have to be readable by one extractor or the assertions quietly pass
 * for the wrong reason.
 */
const ANCHOR_PATTERN = /data-ui-source["']?\s*[:=]\s*["']([^"']+)["']/g;
const COMPONENT_PATTERN = /data-component["']?\s*[:=]\s*["']([^"']+)["']/g;

function anchorsIn(code) {
  return [...code.matchAll(ANCHOR_PATTERN)].map((match) => match[1]);
}

function componentsIn(code) {
  return [...code.matchAll(COMPONENT_PATTERN)].map((match) => match[1]);
}

/* ------------------------------------------------------------------- jsx */

function transform(source, options = {}, filename = `${ROOT}/src/components/ProductCard.tsx`) {
  return modules.babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [[babelPlugin, { root: ROOT, ...options }]],
    ast: false,
    code: true,
  });
}

test("jsx: a host element receives both anchor attributes", { skip }, () => {
  const { code } = transform(`export function ProductCard() {
  return <article className="card"><h2>Hi</h2></article>;
}`);
  assert.deepEqual(anchorsIn(code), [
    "src/components/ProductCard.tsx:2:9",
    "src/components/ProductCard.tsx:2:35",
  ]);
  assert.deepEqual(componentsIn(code), ["ProductCard", "ProductCard"]);
});

test("jsx: a component usage is left alone because its own file carries the anchor", { skip }, () => {
  const { code } = transform(`export function Grid() {
  return <div><ProductCard id="a" /></div>;
}`);
  const anchors = anchorsIn(code);
  assert.equal(anchors.length, 1, "only the host div should be annotated");
  assert.match(anchors[0], /ProductCard\.tsx:2/);
});

test("jsx: a member-expression component is left alone", { skip }, () => {
  const { code } = transform(`export function Form() {
  return <Form.Item name="x" />;
}`);
  assert.deepEqual(anchorsIn(code), []);
});

test("jsx: a namespaced svg element is treated as a host element", { skip }, () => {
  const { code } = transform(`export function Icon() {
  return <svg><svg:path d="M0 0" /></svg>;
}`);
  assert.equal(anchorsIn(code).length, 2);
});

test("jsx: a fragment root annotates its children and not itself", { skip }, () => {
  const { code } = transform(`export function Pair() {
  return <><div>a</div><span>b</span></>;
}`);
  assert.equal(anchorsIn(code).length, 2);
});

test("jsx: tags the runtime probe cannot inventory are not annotated", { skip }, () => {
  const { code } = transform(`export function Doc() {
  return <div><br /><source src="x" /><template>y</template></div>;
}`);
  assert.deepEqual(anchorsIn(code), ["src/components/ProductCard.tsx:2:9"]);
});

test("jsx: the nearest named enclosing component wins over the file name", { skip }, () => {
  const { code } = transform(`export function ProductCard() {
  const Row = () => <li className="row" />;
  return <ul><Row /></ul>;
}`);
  /* Source order: the inner component's element is emitted first. */
  assert.deepEqual(componentsIn(code), ["Row", "ProductCard"]);
});

test("jsx: an anonymous callback still reports its enclosing component", { skip }, () => {
  const { code } = transform(`export function ProductCard({ items }) {
  return <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>;
}`);
  assert.deepEqual(componentsIn(code), ["ProductCard", "ProductCard"]);
});

test("jsx: an HOC-wrapped component keeps its name", { skip }, () => {
  const { code } = transform(`export const Card = memo(({ title }) => <article>{title}</article>);`);
  assert.deepEqual(componentsIn(code), ["Card"]);
});

test("jsx: class component render output reports the class, not the method", { skip }, () => {
  const { code } = transform(`export class Panel extends React.Component {
  render() {
    return <section className="panel" />;
  }
}`);
  assert.deepEqual(componentsIn(code), ["Panel"]);
});

test("jsx: injection is idempotent across a double transform", { skip }, () => {
  const once = transform(`export function A() { return <div className="x" />; }`).code;
  const twice = modules.babel.transformSync(once, {
    filename: `${ROOT}/src/components/A.tsx`,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [[babelPlugin, { root: ROOT }]],
  }).code;
  assert.equal(anchorsIn(twice).length, 1);
  assert.deepEqual(anchorsIn(twice), anchorsIn(once));
});

test("jsx: the anchor is appended after a spread so it cannot be overridden", { skip }, () => {
  const { code } = transform(`export function A(props) {
  return <div {...props} className="x" />;
}`);
  const spread = code.indexOf("...props");
  const anchor = code.indexOf("data-ui-source");
  assert.ok(spread >= 0 && anchor > spread, "anchor must follow the spread");
});

test("jsx: a production build carries no anchors", { skip }, () => {
  const { code } = transform(`export function A() { return <div className="x" />; }`, {
    mode: "production",
  });
  assert.deepEqual(anchorsIn(code), []);
});

test("jsx: dependency and build-output paths are skipped", { skip }, () => {
  for (const filename of [
    `${ROOT}/node_modules/lib/Card.tsx`,
    `${ROOT}/dist/Card.tsx`,
    `${ROOT}/.next/Card.tsx`,
  ]) {
    const { code } = transform(`export function A() { return <div />; }`, {}, filename);
    assert.deepEqual(anchorsIn(code), [], `${filename} should not be annotated`);
  }
});

test("jsx: a file outside the root is skipped instead of emitting an escaping path", { skip }, () => {
  const { code } = transform(`export function A() { return <div />; }`, {}, "/elsewhere/Card.tsx");
  assert.deepEqual(anchorsIn(code), []);
});

test("jsx: an element marked data-symbui-skip is respected", { skip }, () => {
  const { code } = transform(`export function A() {
  return <div data-symbui-skip="1" className="host" />;
}`);
  assert.deepEqual(anchorsIn(code), []);
});

test("jsx: the line and column point at the opening element", { skip }, () => {
  const { code } = transform(`export function A() {
  return (
    <div className="x">
      <span>y</span>
    </div>
  );
}`);
  /* Columns are 0-based, matching Babel's `loc` and the probe's parser. */
  assert.deepEqual(anchorsIn(code), [
    "src/components/ProductCard.tsx:3:4",
    "src/components/ProductCard.tsx:4:6",
  ]);
});

test("jsx: the anchor round-trips through the probe's parser", { skip }, () => {
  const { code } = transform(`export function A() {\n  return <div className="x" />;\n}`);
  const raw = anchorsIn(code)[0];
  const match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  assert.ok(match, "the probe's attributeSource regex must accept the emitted value");
  assert.equal(match[1], "src/components/ProductCard.tsx");
  assert.equal(Number(match[2]), 2);
});

test("jsx: per-file coverage statistics are recorded for the bundler to report", { skip }, () => {
  const result = modules.babel.transformSync(
    `export function A() {
  return <div><Card /><span data-ui-source="x:1" /></div>;
}`,
    {
      filename: `${ROOT}/src/components/A.tsx`,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["jsx", "typescript"] },
      plugins: [[babelPlugin, { root: ROOT }]],
    },
  );
  assert.equal(result.metadata.symbuiAnchors.injected, 1);
  assert.equal(result.metadata.symbuiAnchors.skipped["component-element"], 1);
  assert.equal(result.metadata.symbuiAnchors.skipped["already-annotated"], 1);
});

test("jsx: an element with no location is skipped rather than given a guessed line", { skip }, () => {
  /* Simulates a prior plugin that rewrote nodes without preserving `loc`,
   * which happens in practice and would otherwise produce a wrong anchor that
   * invents a phantom cluster in the revision diff.
   */
  const strip = () => ({
    visitor: {
      JSXOpeningElement(jsxPath) {
        jsxPath.node.loc = null;
      },
    },
  });
  const { code } = modules.babel.transformSync(`export function A() { return <div />; }`, {
    filename: `${ROOT}/src/components/A.tsx`,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [strip, [babelPlugin, { root: ROOT }]],
  });
  assert.deepEqual(anchorsIn(code), []);
});

/* ------------------------------------------------------------------- vue */

/* `compile` receives the template *block's contents*. The SFC wrapper is
 * stripped by @vue/compiler-sfc before this point, and passing the wrapper
 * here would test a shape the real pipeline never produces.
 */
function compileVue(content, options = {}, filename = `${ROOT}/src/components/ProductCard.vue`) {
  return modules.compiler.compile(content, {
    filename,
    mode: "module",
    prefixIdentifiers: true,
    nodeTransforms: [createVueAnchorTransform({ root: ROOT, ...options })],
  });
}

test("vue: a host element receives both anchor attributes", { skip }, () => {
  const { code } = compileVue(`<article class="card"><h2>Hi</h2></article>`);
  assert.deepEqual(anchorsIn(code), [
    "src/components/ProductCard.vue:1:1",
    "src/components/ProductCard.vue:1:23",
  ]);
  assert.deepEqual(componentsIn(code), ["ProductCard", "ProductCard"]);
});

test("vue: a component usage is left alone", { skip }, () => {
  const { code } = compileVue(`<div><ProductCard id="a" /></div>`);
  assert.deepEqual(anchorsIn(code), ["src/components/ProductCard.vue:1:1"]);
});

test("vue: slot, dynamic component, and structural template tags are left alone", { skip }, () => {
  const { code } = compileVue(
    `<div><slot name="x" /><template v-if="ok"><span>y</span></template><component :is="tag" /></div>`,
  );
  assert.equal(anchorsIn(code).length, 2, "only the div and the span are host elements");
});

test("vue: a bare template element is not annotated even though the parser calls it an element", { skip }, () => {
  /* The probe's SKIP_TAGS drops `template`, so an anchor here could never be
   * read back. Vue's own `tagType` says 0 for it, which is exactly why the
   * constraint has to live in anchor-core rather than in the adapter.
   */
  const { code } = compileVue(`<template><div class="x" /></template>`);
  assert.deepEqual(anchorsIn(code), ["src/components/ProductCard.vue:1:11"]);
});

test("vue: each element reports its own line", { skip }, () => {
  const { code } = compileVue(`\n  <div class="a">\n    <span>y</span>\n  </div>\n`);
  assert.deepEqual(anchorsIn(code), [
    "src/components/ProductCard.vue:2:3",
    "src/components/ProductCard.vue:3:5",
  ]);
});

test("vue: a template that already carries anchors is not annotated twice", { skip }, () => {
  const { code } = compileVue(
    `<div class="x" data-ui-source="src/components/ProductCard.vue:1:1"></div>`,
  );
  assert.deepEqual(anchorsIn(code), ["src/components/ProductCard.vue:1:1"]);
});

test("vue: a production build carries no anchors", { skip }, () => {
  const { code } = compileVue(`<div class="x" />`, { mode: "production" });
  assert.deepEqual(anchorsIn(code), []);
});

test("vue: an element marked data-symbui-skip is respected", { skip }, () => {
  const { code } = compileVue(`<div data-symbui-skip="1" class="host" />`);
  assert.deepEqual(anchorsIn(code), []);
});

test("vue: index.vue borrows its directory name as the component name", { skip }, () => {
  const { code } = compileVue(
    `<div class="x" />`,
    {},
    `${ROOT}/src/components/ProductCard/index.vue`,
  );
  assert.deepEqual(componentsIn(code), ["ProductCard"]);
});

test("vue: a file outside every root reports an error instead of failing silently", { skip }, () => {
  const errors = [];
  modules.compiler.compile(`<div class="x" />`, {
    filename: "/elsewhere/Card.vue",
    mode: "module",
    onError: (error) => errors.push(error),
    nodeTransforms: [createVueAnchorTransform({ root: ROOT })],
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "SYMBUI_NO_ROOT");
});

test("vue: zero config works when the build runs from the project root", { skip }, () => {
  /* The transform has no way to reach a bundler's configured root, so it falls
   * back to the working directory — which is the project root for Vite,
   * webpack, and vue-cli alike.
   */
  const filename = path.join(process.cwd(), "src/components/Card.vue");
  const { code } = modules.compiler.compile(`<div class="x" />`, {
    filename,
    mode: "module",
    nodeTransforms: [createVueAnchorTransform()],
  });
  assert.deepEqual(anchorsIn(code), ["src/components/Card.vue:1:1"]);
});

test("vue: a malformed node is ignored rather than throwing", { skip }, () => {
  const transform = createVueAnchorTransform({ root: ROOT });
  const context = { filename: `${ROOT}/src/Card.vue`, onError: () => {} };
  for (const node of [null, undefined, {}, { type: 1 }, { type: 1, tag: "div" }, { type: 2 }]) {
    transform(node, context);
  }
});

/* ------------------------------------------------- cross-layer consistency */

test("the plugin skip list is exactly the probe's SKIP_TAGS", () => {
  const source = fs.readFileSync(
    new URL("../annotate-web-ui/assets/inventory-probe.js", import.meta.url),
    "utf8",
  );
  const block = source.match(/var SKIP_TAGS = \{([\s\S]*?)\};/);
  assert.ok(block, "could not find SKIP_TAGS in the probe");
  const probeTags = [...block[1].matchAll(/([A-Za-z]+)\s*:/g)].map((match) =>
    match[1].toLowerCase(),
  );
  assert.ok(probeTags.length >= 10, "SKIP_TAGS parsed suspiciously short");
  assert.deepEqual(
    [...core.DEFAULT_SKIP_TAGS].sort(),
    probeTags.sort(),
    "the injector and the probe disagree about which elements can be inventoried",
  );
});

test("the probe reads back the attribute names the injectors write", () => {
  const source = fs.readFileSync(
    new URL("../annotate-web-ui/assets/inventory-probe.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes(`getAttribute("${core.ATTRIBUTE_SOURCE}")`));
  assert.ok(source.includes(`getAttribute("${core.ATTRIBUTE_COMPONENT}")`));
});
