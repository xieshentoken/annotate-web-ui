# annotate-web-ui

A local-only Codex skill for converting visual annotations on a live or pure-static web page into an evidence-linked UI change request and implementation prompt — then recapturing the page after the edit, diffing it against the previous revision, and reviewing before/after with the verdicts confirmed or overridden.

## Repository layout

- `annotate-web-ui/` — installable Skill runtime
  - `assets/` — in-page probe, overlay, and the before/after review UI
  - `references/` — the annotation schema, review-loop protocol, model config, build-time anchor wiring, and source resolution
  - `scripts/` — session capture, revision diff, review orchestration, verdict model client
    - `scripts/lib/symbol-index.mjs` — turns annotation evidence into `file:line` candidates
  - `plugins/` — development-only build-time injectors that stamp `data-ui-source` onto every element
- `tests/` — unit tests for the injectors, the diff engine, and the symbol index, real Babel/Vue compiler runs, a real Vite dev server, and isolated-Chrome regression tests

## Install locally

Copy the `annotate-web-ui/` directory into your Codex skills directory:

```bash
cp -R annotate-web-ui ~/.codex/skills/annotate-web-ui
```

## Use

Run the Skill against a local development URL, or a pure static directory/HTML document inside the selected repository:

```text
$annotate-web-ui 打开 '/absolute/path/to/project'
```

Pure static projects are served by the built-in loopback-only Node server; no Python server or `file://` access is required.

## Source anchors

The strongest evidence the pipeline can have is a source file and line per element. The probe can recover it from React or Vue internals, but that reports the component rather than the element and disappears in some builds. The injectors in `annotate-web-ui/plugins/` write it into the markup instead, at compile time and only in development:

```js
// vite.config.js
import { createSymbuiAnchorPlugin } from "./plugins/vite-plugin-symbui.mjs";

export default defineConfig({ plugins: [createSymbuiAnchorPlugin()] });
```

There is also a Vue template transform and a plain Babel plugin for webpack, Next.js, CRA, and anything else that already runs Babel. See [annotate-web-ui/references/build-anchors.md](annotate-web-ui/references/build-anchors.md). This changes the user's build configuration, so the skill offers it rather than doing it silently.

## Source resolution

Once the session is compiled, each annotation is resolved to ranked `file:line` candidates. This is a symbol index rather than a text search: evidence is matched against typed sites, so a `data-testid` attribute and the same string inside a comment are no longer the same thing, and a localized page's visible text is reverse-mapped to its i18n key before the source is searched.

`@babel/parser` is used when it is available and is never a declared dependency. Without it, resolution falls back to lexical scanning, which works but caps every candidate at `medium` confidence and says so in the generated change request. To point the resolver at a parser it cannot find on its own:

```bash
SYMBUI_PARSER_MODULES=/path/to/node_modules node scripts/build-change-spec.mjs \
  --session /path/to/session --repo /path/to/project
```

See [annotate-web-ui/references/source-resolution.md](annotate-web-ui/references/source-resolution.md).

## Verify

```bash
SYMBUI_TEST_MODULES=/path/to/node_modules \
  SYMBUI_PARSER_MODULES=/path/to/node_modules \
  node --test tests/*.test.mjs
```

`@babel/core`, `@babel/parser`, `@vue/compiler-dom`, and `vite` are test-only dependencies; the skill ships none. Without them the affected suites report as skipped rather than failing. The Chrome-driven tests need Google Chrome installed.
