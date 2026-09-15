# Build-Time Anchors

Give every element a source anchor at compile time, so the runtime probe always
knows which file and line produced it.

## Why this exists

The runtime probe can already recover an anchor from framework internals: React's
`__reactFiber$` chain and `_debugSource`, Vue's `type.__file`, Svelte's
`__svelte_meta.loc`. That path has three problems:

- it only works while the framework's own development plugin is active;
- it reports the **component**, not the element, so every element inside a
  component shares one anchor and cannot be told apart;
- it silently returns nothing when a build turns the metadata off, and nothing
  in the pipeline can tell "no anchor" from "anchor not found".

Writing the anchor into the markup removes all three. Coverage becomes total and
independent of framework internals, and a missing anchor becomes an explicit,
countable event rather than an absence.

The anchor is the highest-value signal in the pipeline. It is what lets the
revision diff say "this card's price changed" instead of "a card was inserted
above and everything shifted down".

## The attribute contract

The injectors write exactly what the probe reads. This is a contract, not a
convention — `tests/anchor-plugins.test.mjs` asserts it against the probe source.

| Attribute | Value | Read by |
| --- | --- | --- |
| `data-ui-source` | `src/components/Card.tsx:12:7` — repo-relative file, 1-based line, 0-based column | `attributeSource` in `assets/inventory-probe.js` |
| `data-component` | `ProductCard` — nearest enclosing component | same |

The column is optional; the probe parses `file:line` and `file:line:column`
alike. The file path is always **repository-relative**, because the probe strips
origins and `/@fs/` prefixes and the source index matches on relative paths.

An element that already carries `data-ui-source`, `data-source-file`,
`data-source-line`, or `data-ui-source-line` is left alone. Injection is
idempotent, which matters because dev servers re-transform the same module on
every hot update.

## What gets an anchor

Every rule lives in `planInjection` in `plugins/anchor-core.js`, which is a pure
function over a descriptor and touches no AST. The adapters only supply facts.

| Skipped when | Reason | Why |
| --- | --- | --- |
| production build | `production` | Anchors are development-only. They are not debug data you want to ship. |
| inside `node_modules`, `dist`, `.next`, `.symbui`, … | `excluded-path` | Dependencies and build output are not the user's source. |
| the element is a component usage (`<Card>`, `<Form.Item>`) | `component-element` | The anchor belongs on the element `Card` itself renders, in `Card`'s own file. Annotating the call site would point at the parent. |
| the tag is in the probe's `SKIP_TAGS` | `not-inventoried` | The probe never inventories `template`, `br`, `source`, `script`, and friends. An anchor there could never be read back. |
| no trustworthy line number | `no-line` | A guessed line is worse than none: the diff aligns clusters by `file:line`, so a wrong line invents a phantom cluster. |
| the module is outside every configured root | `outside-root` | A `../other-package/...` path is never matchable against the source index. |
| `data-symbui-skip` or `data-symbui-host` is present | `symbui-host` | The element is overlay scaffolding. |

`not-inventoried` is the rule that bites in practice, and it is the reason the
list lives in `anchor-core` rather than in the Vue adapter. A Vue template's
structural `<template>` wrapper parses as an ordinary element with `tagType` 0,
so the framework's own classification says "host element" and only the shared
list says no.

## Wiring

### Vite, React or plain JSX

```js
// vite.config.js
import { defineConfig } from "vite";
import { createSymbuiAnchorPlugin } from "./plugins/vite-plugin-symbui.mjs";

export default defineConfig({
  plugins: [createSymbuiAnchorPlugin()],
});
```

The plugin runs with `enforce: "pre"` and `apply: "serve"`. The `pre` is load
bearing: Vite's own plugins and `@vitejs/plugin-react` would otherwise have
already erased the JSX, and with it every line number. The `apply: "serve"` is
what keeps production builds clean.

It needs `@babel/core`, which a React project almost always already has. If it
cannot be found the plugin throws at config time with the list of places it
looked, rather than doing nothing.

### Vite, Vue

```js
import vue from "@vitejs/plugin-vue";
import { createVueAnchorTransform } from "./plugins/vue-anchor-transform.mjs";

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          nodeTransforms: [createVueAnchorTransform()],
        },
      },
    }),
  ],
});
```

The template transform runs on *enter* and returns nothing on purpose. User
`nodeTransforms` are appended after the built-in ones, and `transformElement` —
the pass that reads `node.props` and emits them into the render function — is an
`exit` callback. Pushing the attribute during enter means the built-in exit sees
it; returning an exit callback here would be too late.

### Anywhere else that runs Babel

webpack with `babel-loader`, Next.js, CRA, Rspack, Metro, or a bare
`@babel/core` call:

```js
// babel.config.js
module.exports = {
  plugins: [["/abs/path/to/plugins/babel-plugin-symbui-source.js", { root: __dirname }]],
};
```

The Babel plugin has no dependencies of its own — it uses the `types` object
Babel hands to every plugin instead of importing `@babel/types`.

## Why some files are `.mjs` and others are not

This is not stylistic. Bundlers load plugin configs by bundling them: Vite runs
`vite.config.mjs` through esbuild into an ES module, where a CommonJS
`require("path")` becomes a shim that throws `Dynamic require of "path" is not
supported` **before the config loads**. Anything reachable from a config file
therefore has to survive being inlined into an ES module.

| File | Module system | Loaded by |
| --- | --- | --- |
| `anchor-core.js` | CommonJS, **no `require` at all** | both, via interop |
| `babel-plugin-symbui-source.js` | CommonJS, **no `require` at all** | Babel's `require` |
| `vue-anchor-transform.mjs` | ES module | `vite.config` / `compilerOptions` |
| `vite-plugin-symbui.mjs` | ES module | `vite.config` |

The two CommonJS files reach for nothing outside themselves, not even `path` —
path handling is plain string code in `anchor-core.js`, which is deterministic
across platforms and directly testable. That is what lets esbuild inline them
into an ES module without a `require` shim.

## The root, and why it is the failure you will actually hit

Every anchor is repository-relative, which means the injector has to know where
the repository starts. Get it wrong and the result is `outside-root`: the build
succeeds, nothing is annotated, and the review UI quietly has no source
locations.

The defaults are the project root for Vite and the working directory for Babel
and the Vue transform, which covers the ordinary case. Pass `root` explicitly
when the build does not run from the project root:

```js
createSymbuiAnchorPlugin({ root: new URL(".", import.meta.url).pathname })
```

In a monorepo with a hoisted install, add `resolveFrom` so `@babel/core` is
found:

```js
createSymbuiAnchorPlugin({ resolveFrom: "../../node_modules" })
```

## Coverage reporting

A plugin that silently does nothing is the worst outcome, so the Vite plugin
prints what it did:

```text
symbui: 1284 anchors across 96 modules | expected skips: component-element 812,
not-inventoried 140 | UNEXPECTED skips: outside-root 96 — anchors are missing
for reasons that usually mean a misconfigured root
```

`component-element` and `not-inventoried` skips are the design working. Anything
else means anchors are missing for a reason worth reading. The same numbers are
available programmatically as `plugin.api.stats()` and `plugin.api.summary()`.

## Guarantees

- Anchors are written only in development. `mode` defaults to `NODE_ENV`.
- Nothing is injected into a module outside the configured root.
- The injected attribute is appended after any `{...props}` spread, so a
  component cannot override the anchor it was given.
- Component names are stripped of quotes, angle brackets, and control
  characters before they reach the markup.
- No network, no filesystem writes, no runtime dependency.

## Tests

The injectors have unit tests for every rule, real Babel and Vue compiler runs,
and a real Vite dev server:

```bash
SYMBUI_TEST_MODULES=/path/to/node_modules \
  node --test tests/*.test.mjs
```

`@babel/core`, `@babel/parser`, `@vue/compiler-dom`, and `vite` are test-only
dependencies. The skill itself ships none. Without them the affected suites
report as skipped rather than failing — including the resolver suite, whose AST
cases skip instead of failing.

`SYMBUI_TEST_MODULES` points the whole suite at one directory. The resolver
under `scripts/` reads `SYMBUI_PARSER_MODULES` at runtime, and
`tests/symbol-index.test.mjs` accepts either name, so a single directory is
enough for everything. The repository [README](../../README.md#verify) shows
the command that sets both.
