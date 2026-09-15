/* Tests for the source-resolution symbol index.
 *
 * The index has two engines and they must agree on *what a match is* while
 * disagreeing on how much it can be trusted. Most of what follows is about
 * that contract:
 *
 *   - a `data-testid` attribute must outrank the same string in a comment;
 *   - a locale value must be reverse-mapped to its key before searching;
 *   - a lexically scanned file must never claim high confidence;
 *   - a parse failure must degrade, not throw.
 *
 * `@babel/parser` is a test-only dependency here, exactly as `@babel/core` is
 * for the anchor-injector suite. Without it the AST-specific cases report as
 * skipped rather than failing, and the lexical cases still run.
 *
 *   SYMBUI_PARSER_MODULES=/path/to/node_modules \
 *     node --test tests/symbol-index.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLineTable,
  inRanges,
  positionAt,
  scanComments,
  scanStrings,
  scanTagRegions,
  scanTextRuns,
  splitVueSfc,
} from "../annotate-web-ui/scripts/lib/lexical-sites.mjs";
import {
  analyzeFile,
  attributeSiteKind,
  buildI18nIndex,
  collectLocaleFiles,
  createSymbolIndex,
  extractFromAst,
  flattenMessages,
  loadParser,
  looksLikeLocalePath,
  normalizeValue,
  resolveAnnotationCandidates,
} from "../annotate-web-ui/scripts/lib/symbol-index.mjs";

/* Optional test-only dependencies are never declared by the skill, so the
 * harness has to be told where they are. Resolution order: an explicit
 * `SYMBUI_PARSER_MODULES`, then a normal `npm install` in this repository, then
 * the repository root itself. Never a path from one developer's machine. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MODULE_CANDIDATES = [
  process.env.SYMBUI_PARSER_MODULES,
  process.env.SYMBUI_TEST_MODULES,
  path.join(REPO_ROOT, "node_modules"),
  REPO_ROOT,
].filter(Boolean);

/* The directory matters, not just the parser. `buildChangeSpec` runs the
 * production loader, which reads `SYMBUI_PARSER_MODULES` itself and knows
 * nothing about this harness, so the test has to point the variable at wherever
 * the parser was found rather than injecting a parser the production path could
 * never have resolved. */
function loadParserModule() {
  for (const directory of MODULE_CANDIDATES) {
    try {
      const requireFrom = createRequire(path.join(directory, "noop.js"));
      const loaded = requireFrom("@babel/parser");
      /* The production loader rejects a module without `parse` and keeps
       * looking, so the harness has to reject it too — otherwise the suite runs
       * against a directory the code under test would have refused. */
      if (!loaded || typeof loaded.parse !== "function") continue;
      return { parser: loaded, directory };
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

const parserModule = loadParserModule();
const parser = parserModule?.parser ?? null;
const parserDirectory = parserModule?.directory ?? null;
const skipAst = parser
  ? false
  : "install @babel/parser, then set SYMBUI_PARSER_MODULES";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_FILES = {
  "src/components/ProductCard.tsx": `// legacy markup kept data-testid="product-card" on the wrapper
/* block comment: data-testid="product-card" */
import { useTranslation } from "react-i18next";

export function ProductCard({ item }) {
  const { t } = useTranslation();
  const legacyId = "product-card";
  return (
    <article data-testid="product-card" className="card">
      <h3 className="title">{t("product.card.title")}</h3>
      <button type="button">Add to cart</button>
    </article>
  );
}
`,
  "src/components/ProductGrid.tsx": `import { ProductCard } from "./ProductCard";

export function ProductGrid({ items }) {
  return (
    <section data-testid="product-grid" className="grid">
      {items.map((item) => (
        <ProductCard key={item.id} item={item} />
      ))}
    </section>
  );
}
`,
  "src/styles/card.css": `.product-card { border-radius: 12px; }\n/* .card-legacy is gone */\n`,
  "src/locales/zh-CN.json": JSON.stringify(
    { product: { card: { title: "产品卡片", subtitle: "共 12 件商品" } } },
    null,
    2,
  ),
  "src/locales/en.json": JSON.stringify(
    { product: { card: { title: "Product card", subtitle: "12 items" } } },
    null,
    2,
  ),
};

function writeFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "symbui-index-"));
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  return root;
}

const fixtureRoot = writeFixture();
const fixtureSourceFiles = Object.keys(FIXTURE_FILES)
  .filter((relative) => !relative.endsWith(".json"))
  .map((relative) => path.join(fixtureRoot, relative));
const fixtureLocaleFiles = await collectLocaleFiles(fixtureRoot);

const astIndex = await createSymbolIndex({
  root: fixtureRoot,
  files: fixtureSourceFiles,
  localeFiles: fixtureLocaleFiles,
  parser: parser ?? null,
});
const lexicalIndex = await createSymbolIndex({
  root: fixtureRoot,
  files: fixtureSourceFiles,
  localeFiles: fixtureLocaleFiles,
  parser: null,
});

function candidatesFor(index, target, kind = "element") {
  return resolveAnnotationCandidates(index, { id: "A1", kind, target });
}

const CARD = "src/components/ProductCard.tsx";

/* Derived, never hardcoded. An off-by-one in a fixture line number is the kind
 * of test bug that survives review and then gets "fixed" by changing the
 * assertion to match the bug.
 */
const CARD_LINES = FIXTURE_FILES[`${CARD}`].split("\n");
const lineOf = (needle) => {
  const index = CARD_LINES.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `fixture no longer contains ${JSON.stringify(needle)}`);
  return index + 1;
};
const ARTICLE_LINE = lineOf('data-testid="product-card" className');
const H3_LINE = lineOf("product.card.title");
const BUTTON_LINE = lineOf("Add to cart");
const COMMENT_LINE = 1;

// ---------------------------------------------------------------------------
// Lexical primitives
// ---------------------------------------------------------------------------

test("buildLineTable and positionAt use 1-based lines and 0-based columns", () => {
  const text = "one\ntwo\nthree";
  const table = buildLineTable(text);
  assert.deepEqual(positionAt(table, 0), { line: 1, column: 0 });
  assert.deepEqual(positionAt(table, text.indexOf("two")), { line: 2, column: 0 });
  assert.deepEqual(positionAt(table, text.indexOf("three") + 2), { line: 3, column: 2 });
  // Past the end must clamp rather than run off the table.
  assert.deepEqual(positionAt(table, text.length + 50), { line: 3, column: 5 + 50 });
});

test("scanComments does not read a comment marker inside a string as a comment", () => {
  const text = 'const url = "https://example.com/a//b"; // real comment\n';
  const ranges = scanComments(text);
  const slices = ranges.map(([start, end]) => text.slice(start, end));
  assert.deepEqual(slices, ["// real comment"]);
});

test("scanComments handles block comments, HTML comments, and regex literals", () => {
  const text = [
    "const re = /a\\/\\/b/g;",
    "/* block */",
    "<!-- html -->",
  ].join("\n");
  const slices = scanComments(text).map(([start, end]) => text.slice(start, end));
  assert.deepEqual(slices, ["/* block */", "<!-- html -->"]);
});

test("inRanges finds a position inside a range and not outside it", () => {
  const ranges = [
    [5, 10],
    [20, 25],
  ];
  assert.equal(inRanges(ranges, 7), true);
  assert.equal(inRanges(ranges, 10), false);
  assert.equal(inRanges(ranges, 19), false);
  assert.equal(inRanges(ranges, 22), true);
  assert.equal(inRanges(ranges, 4), false);
});

test("scanStrings skips comments and decodes escapes", () => {
  const text = '// "not a string"\nconst a = "line\\nbreak";\nconst b = `tpl`;\n';
  const values = scanStrings(text, scanComments(text)).map((site) => site.value);
  assert.deepEqual(values, ["line\nbreak", "tpl"]);
});

test("scanTagRegions reports closing tags so text runs stay clean", () => {
  const text = '<span aria-label="price">$9</span>';
  const regions = scanTagRegions(text, []);
  assert.deepEqual(
    regions.map((region) => (region.closing ? `/${region.tag}` : region.tag)),
    ["span", "/span"],
  );
  const runs = scanTextRuns(text, regions, []);
  assert.deepEqual(runs.map((run) => run.value), ["$9"]);
});

test("scanTagRegions rejects comparison operators written without a space", () => {
  // `a < b` is guarded by the preceding character; `a <b ? 1 : 2` is not, which
  // is exactly why tag scanning is restricted to markup extensions upstream.
  assert.deepEqual(scanTagRegions("if (a < b) return 1;", []), []);
  assert.deepEqual(scanTagRegions("const ok = a <Card />;", []).map((r) => r.tag), ["Card"]);
});

test("splitVueSfc does not truncate a template that nests another template", () => {
  const sfc = [
    "<script setup lang=\"ts\">",
    "const ok = true",
    "</script>",
    "",
    "<template>",
    "  <div>",
    "    <template v-if=\"ok\">",
    "      <p>inner</p>",
    "    </template>",
    "  </div>",
    "</template>",
  ].join("\n");
  const blocks = splitVueSfc(sfc);
  const template = blocks.find((block) => block.tag === "template");
  assert.ok(template.content.includes("<p>inner</p>"), "inner content must survive");
  assert.ok(template.content.trimEnd().endsWith("</div>"), "outer close must be the boundary");
  assert.equal(sfc.slice(template.contentStart, template.contentStart + 5), "\n  <d");
});

// ---------------------------------------------------------------------------
// Site classification
// ---------------------------------------------------------------------------

test("attributeSiteKind reduces framework bindings to the attribute they bind", () => {
  assert.equal(attributeSiteKind("data-testid"), "jsx-attribute-testid");
  assert.equal(attributeSiteKind(":data-testid"), "jsx-attribute-testid");
  assert.equal(attributeSiteKind("v-bind:data-testid"), "jsx-attribute-testid");
  assert.equal(attributeSiteKind("testId"), "jsx-attribute-testid");
  assert.equal(attributeSiteKind(":href"), "jsx-attribute-href");
  assert.equal(attributeSiteKind("to"), "jsx-attribute-href");
  assert.equal(attributeSiteKind("aria-label"), "jsx-attribute-aria");
  assert.equal(attributeSiteKind("@click"), "jsx-attribute-any");
  assert.equal(attributeSiteKind("className"), "jsx-attribute-any");
});

test("normalizeValue collapses whitespace so multi-line JSX text still matches", () => {
  assert.equal(normalizeValue("  Add\n    to   cart \n"), "Add to cart");
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test("flattenMessages handles nested objects, arrays, and i18next leaves", () => {
  assert.deepEqual(
    flattenMessages({ a: { b: "x" }, list: ["p", "q"], leaf: { message: "m" } }),
    [
      { key: "a.b", text: "x" },
      { key: "list[0]", text: "p" },
      { key: "list[1]", text: "q" },
      { key: "leaf", text: "m" },
    ],
  );
});

test("looksLikeLocalePath accepts locale directories and locale filenames only", () => {
  assert.equal(looksLikeLocalePath("src/locales/zh-CN.json"), true);
  assert.equal(looksLikeLocalePath("src/i18n/messages.json"), true);
  assert.equal(looksLikeLocalePath("public/en.json"), true);
  assert.equal(looksLikeLocalePath("src/data/products.json"), false);
  assert.equal(looksLikeLocalePath("package.json"), false);
});

test("buildI18nIndex reverse-maps a localized value to its key", () => {
  const index = buildI18nIndex([
    {
      relative: "src/locales/zh-CN.json",
      locale: "zh-cn",
      text: JSON.stringify({ product: { card: { title: "产品卡片" } } }),
    },
  ]);
  const hits = index.byText.get("产品卡片");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "product.card.title");
  assert.equal(hits[0].locale, "zh-cn");
});

test("collectLocaleFiles finds locale files and ignores unrelated JSON", async () => {
  fs.writeFileSync(
    path.join(fixtureRoot, "src/data.json"),
    JSON.stringify({ unrelated: true }),
    "utf8",
  );
  const found = await collectLocaleFiles(fixtureRoot);
  const relatives = found.map((entry) => entry.relative).sort();
  assert.deepEqual(relatives, ["src/locales/en.json", "src/locales/zh-CN.json"]);
  assert.equal(found.find((entry) => entry.relative.endsWith("zh-CN.json")).locale, "zh-cn");
});

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

test("extractFromAst records elements, attributes, and declarations with exact positions", { skip: skipAst }, () => {
  const source = [
    "export function Card() {",
    "  return <article data-testid=\"card\"><span>hi</span></article>;",
    "}",
  ].join("\n");
  const ast = parser.parse(source, { sourceType: "module", plugins: ["jsx"] });
  const { elements, sites, declarations } = extractFromAst(ast);

  const article = elements.find((element) => element.tag === "article");
  assert.ok(article, "the article element must be indexed");
  assert.equal(article.component, "Card");
  assert.deepEqual(
    article.attributes.map((attribute) => [attribute.name, attribute.value]),
    [["data-testid", "card"]],
  );
  assert.equal(positionAt(buildLineTable(source), article.start).line, 2);
  assert.ok(declarations.some((declaration) => declaration.name === "Card"));
  assert.ok(
    sites.some((site) => site.kind === "jsx-attribute-testid" && site.value === "card"),
    "the test id must be indexed as an attribute site, not just a string",
  );
});

test("extractFromAst does not let a class method rename the enclosing class", { skip: skipAst }, () => {
  const source = [
    "class Panel {",
    "  render() {",
    "    return <section data-testid=\"panel\" />;",
    "  }",
    "}",
  ].join("\n");
  const ast = parser.parse(source, { sourceType: "module", plugins: ["jsx"] });
  const { elements } = extractFromAst(ast);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].component, "Panel");
});

test("analyzeFile returns the same site kinds whether or not a parser is present", { skip: skipAst }, () => {
  const source = FIXTURE_FILES[`${CARD}`];
  const withAst = analyzeFile(source, ".tsx", { parser, plugins: [] });
  const withoutAst = analyzeFile(source, ".tsx", { parser: null });

  assert.equal(withAst.mode, "ast");
  assert.equal(withoutAst.mode, "lexical");

  const kindsOf = (result) => new Set(result.sites.map((site) => site.kind));
  const astKinds = kindsOf(withAst);
  const lexicalKinds = kindsOf(withoutAst);
  for (const kind of [
    "jsx-attribute-testid",
    "component-declaration",
    "jsx-text",
    "string-literal",
  ]) {
    assert.ok(astKinds.has(kind), `AST engine must produce ${kind}`);
    assert.ok(lexicalKinds.has(kind), `lexical engine must produce ${kind}`);
  }
});

test("analyzeFile treats .ts as TypeScript, not JSX", { skip: skipAst }, () => {
  // `<T>value` is a type assertion in .ts and must not become an element.
  const source = "const cast = <Foo>bar;\nconst cmp = a <b ? 1 : 2;\n";
  const result = analyzeFile(source, ".ts", { parser, plugins: [] });
  assert.equal(result.mode, "ast");
  assert.deepEqual(result.elements, []);
});

// ---------------------------------------------------------------------------
// Resolution behaviour
// ---------------------------------------------------------------------------

test("a test id in a comment never outranks the real attribute", { skip: skipAst }, () => {
  const candidates = candidatesFor(astIndex, {
    tag: "article",
    testId: "product-card",
    componentName: "ProductCard",
  });
  assert.ok(candidates.length > 0);
  const best = candidates[0];
  assert.equal(best.file, CARD);
  assert.equal(best.line, ARTICLE_LINE, "the element wins over the comment on line 1");
  assert.notEqual(best.line, COMMENT_LINE);
  assert.equal(best.confidence, "high");
  assert.equal(best.element.tag, "article");
  assert.equal(best.element.component, "ProductCard");
  assert.ok(
    best.evidence.some((line) => line.includes("jsx-attribute-testid")),
    "the deciding evidence must be the attribute",
  );
});

test("corroboration counts evidence that agrees across a component scope", () => {
  const candidates = candidatesFor(astIndex, {
    tag: "article",
    testId: "product-card",
    componentName: "ProductCard",
  });
  const best = candidates[0];
  assert.ok(
    best.corroborated,
    "the test id on <article> and the ProductCard declaration are in one scope",
  );
  assert.ok(best.corroborated.kinds.includes("test-id"));
  assert.ok(best.corroborated.kinds.includes("source-component"));
  assert.ok(best.corroborated.bonus > 0);
  assert.ok(
    best.evidence.some((line) => line.startsWith("corroborated:")),
    "the bonus must be visible in the evidence, not silent",
  );

  const grid = candidates.find((candidate) => candidate.file.includes("ProductGrid"));
  assert.ok(grid, "the usage site is still reported as a weaker candidate");
  assert.ok(grid.score < best.score);
});

test("localized visible text is reverse-mapped to an i18n key and found at the call site", { skip: skipAst }, () => {
  const candidates = candidatesFor(astIndex, { tag: "h3", text: "产品卡片" });
  assert.ok(candidates.length > 0, "the Chinese text must resolve through the locale file");
  const best = candidates[0];
  assert.equal(best.file, CARD);
  assert.equal(best.i18nKey, "product.card.title");
  assert.equal(best.line, H3_LINE, "the t() call is on the <h3> line");
  assert.equal(best.element.tag, "h3", "the enclosing element is reported for context");
  assert.ok(best.evidence.some((line) => line.includes("产品卡片")));
});

test("the i18n key is reported even when the visible text is English", () => {
  const candidates = candidatesFor(astIndex, { tag: "h3", text: "Product card" });
  const best = candidates.find((candidate) => candidate.i18nKey === "product.card.title");
  assert.ok(best, "an English locale value must reverse-map too");
});

test("a lexical-only index caps confidence at medium", () => {
  const candidates = candidatesFor(lexicalIndex, {
    tag: "article",
    testId: "product-card",
    componentName: "ProductCard",
  });
  assert.ok(candidates.length > 0);
  const best = candidates[0];
  assert.equal(best.file, CARD);
  assert.equal(best.line, ARTICLE_LINE, "the lexical engine must find the same line");
  assert.equal(best.confidence, "medium", "lexical comment handling is a heuristic");
  assert.equal(best.resolver, "lexical");
});

test("confidence keys off the file's mode, not the repository engine", () => {
  // The repository has a parser, but card.css is scanned lexically regardless.
  const candidates = candidatesFor(astIndex, { id: "product-card" });
  const css = candidates.find((candidate) => candidate.file.endsWith(".css"));
  assert.ok(css, "the stylesheet must be a candidate for a class-like id");
  assert.equal(css.resolver, "lexical");
  assert.notEqual(css.confidence, "high");
});

test("a precise attribute match suppresses the loose fallback in the same file", () => {
  // `product-card` appears in this file twice: as the real `data-testid` and as
  // `const legacyId = "product-card"`. Both must not be reported as separate
  // evidence for the same query — the precise one wins and the loose one is
  // dropped, which is what keeps the score meaningful.
  const candidates = candidatesFor(astIndex, { testId: "product-card" });
  const card = candidates.find((candidate) => candidate.file === CARD);
  assert.ok(card, "the card component must be a candidate");

  const testIdEvidence = card.evidence.filter((line) => line.startsWith("test-id:"));
  assert.equal(testIdEvidence.length, 1, "one line of evidence per query kind");
  assert.ok(testIdEvidence[0].includes("jsx-attribute-testid"));
});

test("the loose fallback still fires in files that have no precise match", () => {
  // No element in the fixture carries `id="product-card"`, so the only way to
  // answer this is the string literal and the stylesheet selector.
  const candidates = candidatesFor(astIndex, { id: "product-card" });
  assert.ok(candidates.length > 0, "a fallback-only answer is still an answer");

  const card = candidates.find((candidate) => candidate.file === CARD);
  assert.ok(
    card?.evidence.some(
      (line) => line.startsWith("element-id:") && line.includes("string-literal"),
    ),
    "the literal must be reported at a discount",
  );

  const css = candidates.find((candidate) => candidate.file.endsWith(".css"));
  assert.ok(
    css?.evidence.some(
      (line) => line.startsWith("element-id:") && line.includes("css-selector"),
    ),
    "the stylesheet selector must be reported",
  );
});

test("a precise match outranks a loose one for the same value", { skip: skipAst }, () => {
  // For `test-id`, ProductCard.tsx has both the attribute and a literal; the
  // attribute wins and the literal is suppressed. Compare it against the
  // fallback-only answer for a value that has no attribute anywhere.
  const precise = candidatesFor(astIndex, { testId: "product-card" })[0];
  const loose = candidatesFor(astIndex, { id: "product-card" })[0];
  assert.ok(
    precise.score > loose.score,
    `attribute match ${precise.score} must beat fallback match ${loose.score}`,
  );
  assert.equal(precise.confidence, "high");
  assert.notEqual(loose.confidence, "high");
});

test("redaction annotations produce no candidates", () => {
  assert.deepEqual(candidatesFor(astIndex, { tag: "div" }, "redact"), []);
});

test("an annotation with no usable evidence produces no candidates", () => {
  assert.deepEqual(candidatesFor(astIndex, {}), []);
});

test("describeAt with a column picks the innermost element, without one picks the line's own", { skip: skipAst }, () => {
  const callColumn = CARD_LINES[H3_LINE - 1].indexOf("t(");
  const withColumn = astIndex.describeAt(CARD, H3_LINE, callColumn);
  assert.equal(withColumn.tag, "h3");

  // A `sourceLine` from development metadata has no column; the element that
  // opens on that line must win over the parent that merely contains it.
  const withoutColumn = astIndex.describeAt(CARD, BUTTON_LINE, 0);
  assert.equal(withoutColumn.tag, "button");
  assert.equal(withoutColumn.component, "ProductCard");
  assert.ok(withoutColumn.endLine >= withoutColumn.line);
});

/* The `sourceLine`-without-column rule is the path development metadata takes,
 * so it is worth keeping covered even where no parser is installed. Asserted
 * without `component`, which a lexical scan cannot supply. */
test("describeAt with no column picks the element that opens on the line", () => {
  const withoutColumn = astIndex.describeAt(CARD, BUTTON_LINE, 0);
  assert.equal(withoutColumn?.tag, "button");
});

test("describeAt returns null for an unknown file", () => {
  assert.equal(astIndex.describeAt("does/not/exist.tsx", 1, 0), null);
});

test("a parser that throws degrades to lexical instead of failing the run", async () => {
  const broken = {
    parse() {
      throw new Error("synthetic parser failure");
    },
  };
  const index = await createSymbolIndex({
    root: fixtureRoot,
    files: fixtureSourceFiles,
    localeFiles: [],
    parser: broken,
  });
  // A resolved parser that never succeeds must not be reported as the engine.
  assert.equal(index.engine, "lexical");
  assert.equal(index.stats.parsed, 0);
  assert.ok(index.stats.failed > 0);
  assert.ok(index.parseErrors.length > 0);
  assert.ok(index.parseErrors[0].message.includes("synthetic parser failure"));

  // And it still resolves, just at capped confidence.
  const candidates = candidatesFor(index, { testId: "product-card" });
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].confidence, "medium");
});

test("loadParser reports every directory it tried when no parser is available", () => {
  const result = loadParser(["/nonexistent/one", "/nonexistent/two"]);
  // The environment may legitimately provide a parser; only assert the failure
  // bookkeeping when it did not.
  if (result.parser === null) {
    assert.ok(result.failures.length >= 2);
    assert.ok(result.failures.some((entry) => entry.includes("/nonexistent/one")));
  } else {
    assert.ok(Array.isArray(result.failures));
  }
});

test("createSymbolIndex stats account for every file it was given", () => {
  assert.equal(astIndex.stats.files, fixtureSourceFiles.length);
  assert.equal(astIndex.stats.parsed + astIndex.stats.lexical, astIndex.stats.files);
  assert.ok(astIndex.stats.sites > 0);
  assert.ok(astIndex.stats.elements > 0);
  assert.equal(astIndex.stats.locales, 2);
  assert.equal(astIndex.stats.i18nEntries, 4);
});

test("the index accepts in-memory sources so callers can avoid the filesystem", async () => {
  const index = await createSymbolIndex({
    root: "/virtual",
    files: [{ path: "/virtual/src/Widget.tsx", text: "export const Widget = () => <div data-testid=\"w\" />;\n" }],
    localeFiles: [],
    parser: parser ?? null,
  });
  const candidates = resolveAnnotationCandidates(index, {
    id: "A1",
    kind: "element",
    target: { testId: "w" },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].file, "src/Widget.tsx");
  assert.equal(candidates[0].line, 1);
});

// ---------------------------------------------------------------------------
// build-change-spec end to end
// ---------------------------------------------------------------------------

test("buildChangeSpec writes a request that states which engine resolved it", { skip: skipAst }, async () => {
  const { buildChangeSpec } = await import(
    "../annotate-web-ui/scripts/build-change-spec.mjs"
  );

  const sessionDir = path.join(fixtureRoot, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const name of ["before-S1.png", "annotated-S1.png"]) {
    fs.writeFileSync(path.join(sessionDir, name), "png", "utf8");
  }
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify(
      {
        schemaVersion: "1.1",
        sessionId: "20260914-000000-test",
        createdAt: "2026-09-14T10:00:00.000Z",
        repoPath: fixtureRoot,
        targetUrl: "http://localhost:5173/products",
        states: [
          {
            id: "S1",
            title: "Product list",
            description: "Default desktop view",
            url: "http://localhost:5173/products",
            capturedAt: "2026-09-14T10:01:00.000Z",
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            scroll: { x: 0, y: 0 },
            beforeImage: "before-S1.png",
            annotatedImage: "annotated-S1.png",
          },
        ],
        annotations: [
          {
            id: "A1",
            stateId: "S1",
            kind: "element",
            geometry: { x: 100, y: 200, width: 300, height: 120 },
            target: { tag: "article", testId: "product-card", componentName: "ProductCard" },
            intent: {
              operations: ["style"],
              expected: "Card radius 12px -> 4px",
              scope: "element",
              breakpoint: "all",
              priority: "must",
            },
          },
          {
            id: "A2",
            stateId: "S1",
            kind: "element",
            geometry: { x: 110, y: 210, width: 200, height: 30 },
            target: { tag: "h3", text: "产品卡片" },
            intent: {
              operations: ["style"],
              expected: "Title 26px",
              scope: "element",
              breakpoint: "all",
              priority: "must",
            },
          },
          {
            id: "A3",
            stateId: "S1",
            kind: "element",
            geometry: { x: 110, y: 250, width: 120, height: 36 },
            target: {
              tag: "button",
              text: "Add to cart",
              sourceFile: CARD,
              sourceLine: BUTTON_LINE,
            },
            intent: {
              operations: ["content"],
              expected: "Button label -> 加入购物车",
              scope: "element",
              breakpoint: "all",
              priority: "should",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  /* Drive the production loader rather than bypassing it. `buildChangeSpec`
   * reads `SYMBUI_PARSER_MODULES` itself, so the assertion below only means
   * something if the variable is set the way a user would set it. */
  const previousParserModules = process.env.SYMBUI_PARSER_MODULES;
  if (parserDirectory) process.env.SYMBUI_PARSER_MODULES = parserDirectory;
  let result;
  try {
    result = await buildChangeSpec({ sessionDir, repoPath: fixtureRoot });
  } finally {
    if (previousParserModules === undefined) {
      delete process.env.SYMBUI_PARSER_MODULES;
    } else {
      process.env.SYMBUI_PARSER_MODULES = previousParserModules;
    }
  }
  /* Without this, the test would still pass whenever `process.cwd()` happens to
   * expose the parser, and the `SYMBUI_PARSER_MODULES` path the README
   * documents would go unverified. */
  assert.equal(
    result.resolver.parserFrom,
    parserDirectory,
    "the spec must have been resolved by the parser this harness pointed at",
  );
  const request = fs.readFileSync(result.requestPath, "utf8");
  const prompt = fs.readFileSync(result.promptPath, "utf8");
  const resolved = JSON.parse(fs.readFileSync(result.resolvedPath, "utf8"));

  assert.ok(request.includes("## Resolver"), "the request must state its engine");
  assert.ok(/Engine: (AST|lexical)/.test(request));
  assert.ok(request.includes("Locale files indexed:"));

  const a1 = resolved.find((annotation) => annotation.id === "A1");
  assert.equal(a1.sourceCandidates[0].file, CARD);
  assert.equal(a1.sourceCandidates[0].line, ARTICLE_LINE);
  assert.equal(a1.sourceCandidates[0].element.tag, "article");

  const a2 = resolved.find((annotation) => annotation.id === "A2");
  assert.equal(a2.sourceCandidates[0].i18nKey, "product.card.title");

  const a3 = resolved.find((annotation) => annotation.id === "A3");
  assert.equal(a3.sourceCandidates[0].confidence, "exact");
  assert.equal(a3.sourceCandidates[0].resolver, "metadata");
  assert.equal(
    a3.sourceCandidates[0].element.tag,
    "button",
    "a line-only annotation must still name the element on that line",
  );
  assert.ok(request.includes("development source metadata"));

  assert.ok(prompt.includes("Source resolution:"));
  assert.ok(prompt.includes(`@ ${CARD}:${ARTICLE_LINE} (high)`));
  assert.ok(request.includes("## Unresolved items"));
});

test("the change request states whether build-time anchors carried the run", async () => {
  const { buildChangeSpec } = await import(
    "../annotate-web-ui/scripts/build-change-spec.mjs"
  );

  const sessionDir = path.join(fixtureRoot, "anchor-session");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const name of ["before-S1.png", "annotated-S1.png"]) {
    fs.writeFileSync(path.join(sessionDir, name), "png", "utf8");
  }

  const state = {
    id: "S1",
    title: "Product list",
    description: "Default desktop view",
    url: "http://localhost:5173/products",
    capturedAt: "2026-09-14T10:01:00.000Z",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0 },
    beforeImage: "before-S1.png",
    annotatedImage: "annotated-S1.png",
  };
  const box = {
    id: "A1",
    kind: "box",
    stateId: "S1",
    geometry: { x: 10, y: 20, width: 100, height: 40 },
    target: {},
    intent: {
      operations: ["layout"],
      expected: "Tighten this row",
      scope: "container",
      breakpoint: "all",
      priority: "should",
    },
  };
  const write = (annotations) => {
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify(
        {
          schemaVersion: "1.1",
          sessionId: "20260914-000000-anchors",
          createdAt: "2026-09-14T10:00:00.000Z",
          repoPath: fixtureRoot,
          targetUrl: "http://localhost:5173/products",
          states: [state],
          annotations,
        },
        null,
        2,
      ),
      "utf8",
    );
  };

  // No metadata anywhere: the request must say so, and the CLI must warn.
  write([box]);
  const withoutAnchors = await buildChangeSpec({
    sessionDir,
    repoPath: fixtureRoot,
  });
  const bare = fs.readFileSync(withoutAnchors.requestPath, "utf8");
  assert.ok(bare.includes("- Build-time anchors: none resolved"));
  assert.ok(
    bare.includes("Wiring the development-only injectors"),
    "a run with no anchors must point at the injectors",
  );
  assert.ok(
    withoutAnchors.warnings.some((warning) =>
      warning.includes("development source metadata"),
    ),
    "the CLI must warn about the missing anchors",
  );

  /* Metadata naming a file the index cannot see is a different state from
   * having no metadata at all: the injectors are already wired, so telling the
   * reader to install them would send them to fix the wrong thing. */
  write([
    { ...box, target: { sourceFile: "src/components/Gone.tsx", sourceLine: 4 } },
  ]);
  const staleAnchors = await buildChangeSpec({
    sessionDir,
    repoPath: fixtureRoot,
  });
  const stale = fs.readFileSync(staleAnchors.requestPath, "utf8");
  assert.ok(stale.includes("- Build-time anchors: none resolved"));
  assert.ok(
    stale.includes("may have moved or been renamed"),
    "metadata that resolves to nothing must not be reported as absent metadata",
  );
  assert.ok(
    !stale.includes("Wiring the development-only injectors"),
    "an annotation that already carries metadata must not be told to install it",
  );

  /* Metadata on one annotation and absent on another: the advice has to follow
   * the annotations that actually lack it, not the run as a whole. */
  write([
    { ...box, id: "A1", target: { sourceFile: CARD, sourceLine: ARTICLE_LINE } },
    { ...box, id: "A2" },
  ]);
  const partial = await buildChangeSpec({
    sessionDir,
    repoPath: fixtureRoot,
  });
  const mixed = fs.readFileSync(partial.requestPath, "utf8");
  assert.ok(mixed.includes("1/2 resolved from"));
  assert.ok(
    mixed.includes("Wiring the development-only injectors"),
    "a target with no metadata at all still needs the injectors",
  );
  assert.ok(
    !mixed.includes("may have moved or been renamed"),
    "the moved-file advice is for metadata that failed to resolve, not for its absence",
  );
});
