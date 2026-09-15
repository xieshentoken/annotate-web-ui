# Source Resolution

How an annotation's DOM evidence becomes a `file:line` a coding agent can act
on. Implemented in `scripts/lib/symbol-index.mjs` and
`scripts/lib/lexical-sites.mjs`, consumed by `scripts/build-change-spec.mjs`.

## Why it is not a text search

The first implementation read every source file and ran `text.indexOf` for each
piece of evidence. Three failures followed from that, and every design decision
below exists to close one of them:

1. **`indexOf` cannot tell an attribute from a comment.** A
   `// TODO: remove data-testid="x"` comment scored exactly as high as the real
   element. The resolver now records *typed sites*, and a comment is not a site.
2. **It re-read and re-scanned the whole tree per annotation.** 5000 files and
   20 annotations meant 100k reads. The index is built once and every annotation
   is answered from it.
3. **It found a byte offset and then counted newlines by slicing the file.**
   Line numbers now come from a line table built once per file, with a binary
   search per lookup.

## Two engines, one set of site kinds

`@babel/parser` is optional and is never a declared dependency.

- **AST engine** — used when a parser resolves. Loader order is
  `SYMBUI_PARSER_MODULES`, then `<repo>/node_modules`, then `<repo>`, then cwd.
  A `.vue` file's `<script>` block is parsed; its `<template>` block is scanned
  lexically, because a template is not JavaScript.
- **Lexical engine** — used for stylesheets, for markup files, for any file over
  `MAX_PARSE_BYTES` (512KB), and for everything when no parser is available.

Both emit the *same site kinds*, so the scorer has no branch on engine. What
differs is trust, expressed through `confidence`:

| `resolver` on a candidate | what it means |
| --- | --- |
| `metadata` | explicit `sourceFile` from development-only build metadata |
| `ast` | the file was parsed; positions and comment exclusion are exact |
| `lexical` | recovered from raw text; comment detection is a heuristic |

**A lexically scanned file can never reach `high` confidence**, and is capped at
`medium`. This keys off the *file's* mode, not the repository-wide engine: a
`.css` file is lexically scanned even when a parser was found, and a `.tsx` file
that failed to parse is lexically scanned even when every other file parsed.

`stats.engine` reports what actually produced the sites, not what was available.
A parser that resolves but throws on every file leaves everything lexically
scanned, and the artifact says so.

## Site kinds and weights

A query names the site kinds that count as a precise answer. Matching one of
those is worth the query's full score; a fallback site is discounted, and only
competes in files where no precise site matched.

| site kind | weight | meaning |
| --- | --- | --- |
| `jsx-attribute-testid` | 1.0 | `data-testid` / `testId` / `:data-testid` / `v-bind:data-testid` |
| `jsx-attribute-id` | 1.0 | `id` |
| `jsx-attribute-aria` | 1.0 | `aria-label`, `aria-labelledby`, `alt`, `title` |
| `jsx-attribute-placeholder` | 1.0 | `placeholder` |
| `jsx-attribute-href` | 1.0 | `href`, `to`, `src` |
| `jsx-text` | 1.0 | a text node |
| `component-declaration` | 1.0 | `function Card`, `const Card =`, `class Card` |
| `component-usage` | 0.9 | `<Card` |
| `i18n-call` | 1.0 | the key argument of `t(...)`, `$t(...)`, `translate(...)` |
| `jsx-attribute-any` | 0.8 | any other attribute |
| `string-literal` | 0.6 | a literal anywhere |
| `identifier` | 0.6 | an identifier reference |
| `css-selector` | 0.5 | a class or id selector |

A comment is not a site kind. It is a range that is skipped during extraction,
in both engines.

`string-literal`, `identifier`, and `css-selector` are the *loose* kinds: they
need a needle of at least 3 characters, because a two-character needle against
them matches half the repository. Precise kinds accept a single character —
`data-testid="w"` and `id="a"` are legal and unambiguous.

## Query scores

| annotation field | kind | score | precise sites |
| --- | --- | --- | --- |
| `target.testId` / `data-testid` | `test-id` | 100 | `jsx-attribute-testid` |
| `target.componentName` | `source-component` | 92 | `component-declaration`, `component-usage` |
| derived from i18n reverse lookup | `i18n-key` | 88 | `i18n-call`, `i18n-object-key` |
| `target.id` | `element-id` | 86 | `jsx-attribute-id` |
| `target.accessibleName` / `aria-label` | `aria-label` | 76 | `jsx-attribute-aria` |
| `target.text` | `visible-text` | 64 | `jsx-text` |
| `attributes.placeholder` | `placeholder` | 60 | `jsx-attribute-placeholder` |
| `attributes.href` | `href` | 54 | `jsx-attribute-href` |

Confidence thresholds: `high` needs a score of at least 100 **and** at least one
precise site; `medium` needs 70; otherwise `low`. The "and at least one precise
site" clause is what stops a pile of loose literal matches from adding up to a
`high` claim.

## Corroboration

Two independent kinds of evidence agreeing on one place is worth more than the
same total spread across a file, and it identifies the line the user pointed at
rather than the line a string happened to appear on.

Two shapes count, and the second is the one that fires:

- kinds landing on the **same element** — the test id and the text are both on
  the `<button>`;
- a kind landing on an element plus a different kind landing anywhere in the
  **same component scope** — the usual case, because a component is declared at
  the top of the file and the element is further down.

Grouping by element index alone was the obvious implementation and it almost
never fired: a `component-declaration` site has no element, so the test id and
the component name never shared a group. A rule that silently never applies is
worse than no rule, because it reads as if it is doing something. Every site
therefore records the component it sits inside.

The bonus is `12 × (kinds − 1)`, and it is written into the candidate's
`evidence` so it is visible rather than silent. An annotation that names a
component which the evidence also lands inside gets a further `+10`.

## i18n reverse lookup

A localized UI does not contain the text the user annotated. The DOM says
`产品卡片`; the source says `t("product.card.title")`. Searching the visible text
against source text finds nothing at all.

Locale files are indexed in reverse — value to key — and the key is what gets
searched:

1. `collectLocaleFiles` walks for `.json` files under a locale-ish directory
   (`locales`, `i18n`, `lang`, `messages`, `translations`, `intl`) or named like
   a locale code (`zh-CN.json`, `en.json`). Caps: 60 files, 256KB each, 4MB
   total.
2. `flattenMessages` flattens nested objects to dotted keys, arrays to
   `key[0]`, and accepts i18next's `{ "key": { "message": "..." } }` leaf.
3. Both the exact value and its lowercased form are indexed. If the exact lookup
   misses and the needle is at least 4 characters, a bounded containment pass
   runs so a clipped annotation text can still match a longer locale value.

A hit produces an `i18n-key` query at score 88. It sits just below
`source-component` because it is strong and specific but goes through one
indirection: visible text → locale value → key → call site. The candidate
reports `i18nKey` and its `element` names the enclosing element, so the agent
sees `<h3> inside ProductCard` next to the `t()` call rather than a bare line
number.

## Element description

`describeAt(file, line, column)` answers "what element is this?".

- With a column: the smallest element containing that exact offset. This is what
  makes `<h3>{t("x")}</h3>` resolve to the `<h3>` rather than the enclosing
  `<article>`.
- Without a column: `sourceLine` from development metadata has no column, and a
  column-0 lookup cannot see an element that opens mid-line — it would report
  the parent. So the smallest element that *opens on that line* wins, and only
  if there is none does containment decide.

## Degradation is reported, never silent

`buildChangeSpec` writes a `## Resolver` section into `change-request.md` and a
`Source resolution:` line into `implementation-prompt.md`. Both state the engine
and why. Session warnings are emitted when:

- `@babel/parser` was not found — and the search path is listed;
- a parser loaded but no file parsed;
- individual files failed to parse (first five, then a count).

Each candidate also carries `resolver` and `fileMode`, so a reader can tell a
precise answer from a recovered one without cross-referencing anything.

## Adding a language

For a new script extension, add it to `SCRIPT_EXTENSIONS`. The AST engine will
parse it with `jsx` and `typescript` plugins chosen per extension, plus whatever
optional plugins the installed parser accepted at load time (probed, not
hardcoded, because `importAttributes` replaced `importAssertions` and
combinations conflict).

For a new markup extension, add it to `MARKUP_EXTENSIONS` **only if** a bare
`<name` in that language cannot be a comparison. `a <b ? 1 : 2` is valid in
`.ts`, and is lexically indistinguishable from an element; that is why `.ts` is
excluded and `.tsx` is not. Getting this wrong silently invents elements.

For a `.vue`-like single-file format, follow `analyzeVueFile`: parse the script
block, scan the template block, and offset every site so the file's single line
table covers both.
