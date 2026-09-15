import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require("../annotate-web-ui/plugins/anchor-core.js");

const { planInjection, isHostTag, relativize, sanitizeAttributeValue } = core;

const ROOT = "/repo";

function descriptor(overrides = {}) {
  return {
    tag: "div",
    file: path.join(ROOT, "src/components/ProductCard.tsx"),
    line: 12,
    column: 7,
    component: "ProductCard",
    mode: "development",
    root: ROOT,
    attributes: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------- happy path */

test("a host element in development gets a repository-relative anchor", () => {
  const plan = planInjection(descriptor());
  assert.equal(plan.inject, true);
  assert.equal(plan.reason, "ok");
  assert.deepEqual(plan.anchor, {
    file: "src/components/ProductCard.tsx",
    line: 12,
    column: 7,
    component: "ProductCard",
    root: ROOT,
  });
  assert.deepEqual(plan.attributes, [
    { name: "data-ui-source", value: "src/components/ProductCard.tsx:12:7" },
    { name: "data-component", value: "ProductCard" },
  ]);
});

test("the anchor value is exactly what the runtime probe parses back", () => {
  const plan = planInjection(descriptor());
  const value = plan.attributes[0].value;
  const match = value.match(/^(.*?):(\d+)(?::(\d+))?$/);
  assert.ok(match, "value must be parseable by the probe's attributeSource regex");
  assert.equal(match[1], "src/components/ProductCard.tsx");
  assert.equal(Number(match[2]), 12);
  assert.equal(Number(match[3]), 7);
});

test("emitColumn false writes the short file:line form", () => {
  const plan = planInjection(descriptor(), { emitColumn: false });
  assert.equal(plan.attributes[0].value, "src/components/ProductCard.tsx:12");
});

test("a missing column falls back to file:line", () => {
  const plan = planInjection(descriptor({ column: null }));
  assert.equal(plan.attributes[0].value, "src/components/ProductCard.tsx:12");
});

test("a zero column is not emitted", () => {
  const plan = planInjection(descriptor({ column: 0 }));
  assert.equal(plan.attributes[0].value, "src/components/ProductCard.tsx:12");
});

test("an unknown component name omits data-component rather than emitting an empty one", () => {
  const plan = planInjection(descriptor({ component: "" }));
  assert.deepEqual(plan.attributes, [
    { name: "data-ui-source", value: "src/components/ProductCard.tsx:12:7" },
  ]);
  assert.equal(plan.anchor.component, "");
});

test("emitComponent false suppresses data-component even when the name is known", () => {
  const plan = planInjection(descriptor(), { emitComponent: false });
  assert.equal(plan.attributes.length, 1);
  assert.equal(plan.attributes[0].name, "data-ui-source");
});

test("attribute names can be overridden for an unusual toolchain", () => {
  const plan = planInjection(descriptor(), {
    attributeSource: "data-src-anchor",
    attributeComponent: "data-src-component",
  });
  assert.deepEqual(
    plan.attributes.map((attribute) => attribute.name),
    ["data-src-anchor", "data-src-component"],
  );
});

/* ------------------------------------------------------- host element rule */

test("isHostTag accepts lowercase DOM and SVG tags", () => {
  for (const tag of ["div", "button", "my-widget", "h1", "svg", "path"]) {
    assert.equal(isHostTag(tag), true, `${tag} should be a host element`);
  }
});

test("isHostTag accepts namespaced SVG tags", () => {
  assert.equal(isHostTag("svg:path"), true);
  assert.equal(isHostTag("xlink:href"), true);
});

test("isHostTag rejects components, member expressions, and fragments", () => {
  for (const tag of ["Card", "ProductCard", "Form.Item", "motion.div", "", "UI.Button"]) {
    assert.equal(isHostTag(tag), false, `${tag} should not be a host element`);
  }
});

test("a component usage is skipped because its own file carries the anchor", () => {
  const plan = planInjection(descriptor({ tag: "ProductCard", component: "ProductGrid" }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "component-element");
  assert.deepEqual(plan.attributes, []);
  assert.equal(plan.anchor, null);
});

test("an adapter-supplied host flag overrides the tag heuristic", () => {
  const plan = planInjection(descriptor({ tag: "Card", host: true }));
  assert.equal(plan.inject, true);
  const rejected = planInjection(descriptor({ tag: "div", host: false }));
  assert.equal(rejected.reason, "component-element");
});

/* ----------------------------------------------------------- mode gating */

test("production builds never carry anchors", () => {
  const plan = planInjection(descriptor({ mode: "production" }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "production");
});

test("test mode behaves like development", () => {
  assert.equal(planInjection(descriptor({ mode: "test" })).inject, true);
});

/* --------------------------------------------------------- path exclusion */

test("dependency and build-output paths are excluded", () => {
  const cases = [
    "/repo/node_modules/react/index.js",
    "/repo/dist/assets/main.js",
    "/repo/.next/server/page.js",
    "/repo/.nuxt/components/Card.vue",
    "/repo/.symbui/sessions/s1/injected.js",
    "/repo/packages/ui/coverage/lcov.js",
  ];
  for (const file of cases) {
    const plan = planInjection(descriptor({ file, root: "/repo" }));
    assert.equal(plan.inject, false, `${file} should be excluded`);
    assert.equal(plan.reason, "excluded-path");
  }
});

test("a project directory that merely contains a reserved word is kept", () => {
  const plan = planInjection(descriptor({ file: "/repo/src/build-helpers/tokens.ts" }));
  assert.equal(plan.inject, true);
  assert.equal(plan.anchor.file, "src/build-helpers/tokens.ts");
});

test("the exclusion list is configurable", () => {
  const plan = planInjection(
    descriptor({ file: "/repo/vendor-ui/Card.tsx" }),
    { exclude: ["vendor"] },
  );
  assert.equal(plan.inject, true);
  assert.equal(plan.anchor.file, "vendor-ui/Card.tsx");
});

/* ----------------------------------------------------------- idempotency */

test("an element that already carries data-ui-source is left alone", () => {
  const plan = planInjection(descriptor({ attributes: ["className", "data-ui-source"] }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "already-annotated");
  assert.equal(plan.detail, "data-ui-source");
});

test("an element carrying a foreign anchor spelling is left alone too", () => {
  for (const name of ["data-source-file", "data-source-line", "data-ui-source-line"]) {
    const plan = planInjection(descriptor({ attributes: [name] }));
    assert.equal(plan.inject, false, `${name} should block injection`);
    assert.equal(plan.reason, "already-annotated");
    assert.equal(plan.detail, name);
  }
});

test("attribute lists are accepted as plain names, objects, or AST-like nodes", () => {
  assert.deepEqual(core.attributeNames(["a", "b"]), ["a", "b"]);
  assert.deepEqual(core.attributeNames([{ name: "a" }, { name: "b" }]), ["a", "b"]);
  assert.deepEqual(core.attributeNames([{ key: { name: "a" } }]), ["a"]);
  assert.deepEqual(core.attributeNames(null), []);
  assert.deepEqual(core.attributeNames([42, null]), []);
});

/* ------------------------------------------------------------- line rules */

test("an untrustworthy line skips the element instead of guessing one", () => {
  for (const line of [null, undefined, 0, -3, NaN, Infinity, "abc"]) {
    const plan = planInjection(descriptor({ line }));
    assert.equal(plan.inject, false, `line ${String(line)} should be rejected`);
    assert.equal(plan.reason, "no-line");
  }
});

test("a numeric string line is accepted and a fractional line is floored", () => {
  assert.equal(planInjection(descriptor({ line: "42" })).anchor.line, 42);
  assert.equal(planInjection(descriptor({ line: 42.7 })).anchor.line, 42);
});

/* ------------------------------------------------------------- root rules */

test("the configured root wins over a nested package root", () => {
  const plan = planInjection(
    descriptor({
      file: "/repo/packages/ui/src/Card.tsx",
      root: "/repo",
      packageRoot: "/repo/packages/ui",
    }),
  );
  assert.equal(plan.anchor.file, "packages/ui/src/Card.tsx");
});

test("a package root rescues a file that sits outside the configured root", () => {
  const plan = planInjection(
    descriptor({
      file: "/elsewhere/ui/src/Card.tsx",
      root: "/repo",
      packageRoot: "/elsewhere/ui",
    }),
  );
  assert.equal(plan.inject, true);
  assert.equal(plan.anchor.file, "src/Card.tsx");
});

test("a file outside every root is skipped rather than emitted as an escaping path", () => {
  const plan = planInjection(descriptor({ file: "/elsewhere/ui/src/Card.tsx", root: "/repo" }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "outside-root");
});

test("no configured root at all is reported distinctly", () => {
  const plan = planInjection(descriptor({ root: undefined, packageRoot: undefined }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "outside-root");
  assert.equal(plan.detail, "no root configured");
});

test("a sibling directory sharing a name prefix is not treated as inside the root", () => {
  assert.equal(relativize("/repo/srcfoo/a.tsx", "/repo/src"), null);
  const plan = planInjection(descriptor({ file: "/repo/srcfoo/a.tsx", root: "/repo/src" }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "outside-root");
});

test("roots can be supplied as an ordered list, first match wins", () => {
  const plan = planInjection(
    descriptor({
      file: "/repo/packages/ui/src/Card.tsx",
      roots: ["/repo/packages/ui", "/repo"],
      root: undefined,
      packageRoot: undefined,
    }),
  );
  assert.equal(plan.anchor.file, "src/Card.tsx");
  assert.equal(plan.anchor.root, "/repo/packages/ui");
});

test("Windows separators are normalized to posix in the emitted anchor", () => {
  const plan = planInjection(
    descriptor({ file: "C:\\repo\\src\\components\\Card.tsx", root: "C:\\repo" }),
  );
  assert.equal(plan.inject, true);
  assert.equal(plan.anchor.file, "src/components/Card.tsx");
  assert.ok(!plan.attributes[0].value.includes("\\"));
});

/* ---------------------------------------------------------------- hostile */

test("a component name cannot break out of the attribute it is written into", () => {
  const plan = planInjection(descriptor({ component: 'Evi"l <script>x</script>' }));
  const value = plan.attributes[1].value;
  assert.ok(!/["'`<>&\\]/.test(value), `unexpected character in ${value}`);
  /* `/` survives on purpose: it is inert inside a quoted attribute value, and
   * stripping it would mangle legitimate names such as `Foo/Bar`.
   */
  assert.equal(value, "Evil scriptx/script");
});

test("a control character in a path is stripped from the attribute value", () => {
  assert.equal(sanitizeAttributeValue("a\u0000b\nc"), "abc");
});

test("the overlay host is never annotated", () => {
  const plan = planInjection(descriptor({ insideSymbuiHost: true }));
  assert.equal(plan.inject, false);
  assert.equal(plan.reason, "symbui-host");
});

test("missing or malformed descriptors are rejected without throwing", () => {
  for (const input of [undefined, null, 42, "div", []]) {
    const plan = planInjection(input);
    assert.equal(plan.inject, false);
    assert.equal(plan.reason, "no-descriptor");
  }
});

test("a missing or empty file is rejected", () => {
  assert.equal(planInjection(descriptor({ file: "" })).reason, "no-file");
  assert.equal(planInjection(descriptor({ file: undefined })).reason, "no-file");
});

/* ------------------------------------------------------------- rule table */

test("every reason the planner can return is documented", () => {
  const documented = new Set(core.describeReasons().map((entry) => entry.reason));
  const observed = new Set();
  const probes = [
    undefined,
    descriptor({ mode: "production" }),
    descriptor({ file: "" }),
    descriptor({ insideSymbuiHost: true }),
    descriptor({ file: "/repo/node_modules/a.js" }),
    descriptor({ tag: "Card" }),
    descriptor({ attributes: ["data-ui-source"] }),
    descriptor({ line: null }),
    descriptor({ file: "/elsewhere/a.tsx" }),
    descriptor(),
  ];
  for (const probe of probes) observed.add(planInjection(probe).reason);
  observed.add("outside-root");
  for (const reason of observed) {
    assert.ok(documented.has(reason), `reason ${reason} is not documented`);
  }
  for (const entry of core.describeReasons()) {
    assert.ok(entry.detail.length > 20, `reason ${entry.reason} needs a real explanation`);
  }
});
