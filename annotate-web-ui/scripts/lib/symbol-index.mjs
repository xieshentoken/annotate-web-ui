/* Symbol index: resolve a visual annotation to source locations.
 *
 * ## Why this exists
 *
 * The first implementation searched every source file for each piece of
 * annotation evidence with `text.indexOf`. Three things were wrong with that:
 *
 * 1. `indexOf` cannot tell an attribute from a comment. A `data-testid` value
 *    that appeared in a `// TODO: remove data-testid="x"` comment scored the
 *    same as the real element.
 * 2. It re-read and re-scanned every file for every annotation. With 5000
 *    files and 20 annotations that is 100k file reads.
 * 3. It found the byte offset, then counted newlines by slicing the whole file
 *    — O(file size) per candidate.
 *
 * This module reads and parses each file once, records *typed sites* (an
 * attribute, a declaration, a call argument, a string literal), and answers
 * every annotation from that index.
 *
 * ## Two engines, one set of site kinds
 *
 * `@babel/parser` is optional. It ships with essentially every React/Vue/Vite
 * project, and the loader looks in the repository's own `node_modules`, but
 * the skill must never hard-fail without it. When no parser is found the
 * lexical engine takes over and recovers the same site kinds from raw text.
 *
 * The scorer has no branch on engine. What changes is *confidence*: a lexical
 * match can reach `medium` but never `high`, because lexical comment detection
 * is a heuristic and cannot prove the match is not inside a comment. Every
 * candidate carries `resolver: "ast" | "lexical"` so the degradation is
 * visible in the artifact rather than silent.
 *
 * ## i18n
 *
 * A localized UI does not contain the text the user annotated. The string in
 * the DOM is `产品卡片`; the source says `t("product.card.title")`. Matching the
 * visible text against source text finds nothing at all. So locale files are
 * indexed in reverse — value to key — and the key is what gets searched.
 *
 * ## What is deliberately not here
 *
 * There is no skip-tag list. `plugins/anchor-core.js` already owns the rule
 * about which tags the runtime probe inventories, and a second copy here would
 * be a third thing to keep in sync for no benefit: resolution matches evidence
 * strings against sites, and a wrapper element with no attributes contributes
 * no sites either way.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildLineTable,
  positionAt,
  scanComments,
  scanCssSelectors,
  scanIdentifiers,
  scanStrings,
  scanTagRegions,
  scanTextRuns,
  splitVueSfc,
} from "./lexical-sites.mjs";

/* Extensions where a `<tag>` is markup rather than a comparison. See the
 * `scanTagRegions` doc comment: `a <b ? 1 : 2` is valid in `.ts` and
 * lexically identical to an element, so tag scanning is off there. */
export const MARKUP_EXTENSIONS = new Set([
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
]);

export const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
]);

export const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);

/* Files above this size are indexed lexically. A 512KB generated bundle is not
 * worth a parse; a hand-written component never gets close. */
export const MAX_PARSE_BYTES = 512 * 1024;

/* How much each kind of match is worth, once a query has landed on it. The
 * point of the table is that a `data-testid` *attribute* is full-strength
 * evidence while the same string appearing somewhere in the file is not. */
export const SITE_WEIGHTS = {
  "jsx-attribute-testid": 1,
  "jsx-attribute-id": 1,
  "jsx-attribute-aria": 1,
  "jsx-attribute-placeholder": 1,
  "jsx-attribute-href": 1,
  "jsx-attribute-name": 1,
  "jsx-attribute-any": 0.8,
  "jsx-text": 1,
  "component-declaration": 1,
  "component-usage": 0.9,
  "i18n-call": 1,
  "i18n-object-key": 1,
  "string-literal": 0.6,
  identifier: 0.6,
  "css-selector": 0.5,
};

const ATTRIBUTE_KINDS = new Map([
  ["data-testid", "jsx-attribute-testid"],
  ["testid", "jsx-attribute-testid"],
  ["test-id", "jsx-attribute-testid"],
  ["data-test", "jsx-attribute-testid"],
  ["data-qa", "jsx-attribute-testid"],
  ["id", "jsx-attribute-id"],
  ["aria-label", "jsx-attribute-aria"],
  ["aria-labelledby", "jsx-attribute-aria"],
  ["alt", "jsx-attribute-aria"],
  ["title", "jsx-attribute-aria"],
  ["placeholder", "jsx-attribute-placeholder"],
  ["href", "jsx-attribute-href"],
  ["to", "jsx-attribute-href"],
  ["src", "jsx-attribute-href"],
  ["name", "jsx-attribute-name"],
]);

/* `:data-testid`, `v-bind:href`, `@click`, `#slot` all reduce to the attribute
 * they bind. Vue's shorthand is the common case in the wild. */
const BINDING_PREFIX = /^(?:v-bind:|:|@|v-on:|#|v-slot:)/;

export function attributeSiteKind(rawName) {
  const name = String(rawName || "").replace(BINDING_PREFIX, "").toLowerCase();
  return ATTRIBUTE_KINDS.get(name) || "jsx-attribute-any";
}

const I18N_CALLEES = new Set([
  "t",
  "$t",
  "translate",
  "i18n",
  "formatMessage",
  "intl",
  "useTranslation",
]);

const DECLARATION_TYPES = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "VariableDeclarator",
  "ObjectProperty",
  "ObjectMethod",
  "ClassProperty",
  "TSDeclareFunction",
]);

/* Node keys that hold positions, comments, or tokens rather than children.
 * Walking into them would visit every node twice and count comments as code. */
const SKIP_CHILD_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
  "type",
]);

export function normalizeValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Parser loading
// ---------------------------------------------------------------------------

const OPTIONAL_PLUGINS = [
  "decorators-legacy",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "topLevelAwait",
  "importAttributes",
];

const PLUGIN_PROBE =
  "class A { #x = 1 }\nconst f = async () => await 1;\nconst t = <T,>(v: T) => v;\nconst j = <div a={1} />;";

/* Optional syntax plugins differ between Babel versions: `importAttributes`
 * replaced `importAssertions`, and some combinations conflict. Rather than
 * hardcoding a list that will be wrong on somebody's lockfile, probe each one
 * once and then shrink the set until the whole combination parses.
 *
 * `jsx` and `typescript` are not probed here — they are chosen per file, since
 * a `.ts` file must not be parsed as JSX.
 */
function resolvePluginExtras(parser) {
  const supported = [];
  for (const plugin of OPTIONAL_PLUGINS) {
    try {
      parser.parse("const a = 1;", { sourceType: "module", plugins: [plugin] });
      supported.push(plugin);
    } catch {
      /* Not available in this parser version. */
    }
  }

  while (supported.length > 0) {
    try {
      parser.parse(PLUGIN_PROBE, {
        sourceType: "module",
        plugins: ["jsx", "typescript", ...supported],
      });
      return supported;
    } catch {
      supported.pop();
    }
  }

  return [];
}

export function loadParser(bases = []) {
  const candidates = [
    process.env.SYMBUI_PARSER_MODULES,
    ...bases,
    process.cwd(),
  ].filter((value) => typeof value === "string" && value.length > 0);

  const failures = [];
  for (const base of candidates) {
    try {
      const requireFrom = createRequire(path.join(base, "__symbui_resolve__.cjs"));
      const parser = requireFrom("@babel/parser");
      if (!parser || typeof parser.parse !== "function") {
        failures.push(`${base}: resolved @babel/parser without parse()`);
        continue;
      }
      return { parser, from: base, plugins: resolvePluginExtras(parser), failures };
    } catch (error) {
      failures.push(`${base}: ${error?.code || error?.message || error}`);
    }
  }

  return { parser: null, from: null, plugins: [], failures };
}

function parserOptionsFor(ext, scriptLang, extras = []) {
  const lang = String(scriptLang || "").toLowerCase();
  const typescript = [".ts", ".tsx"].includes(ext) || ["ts", "tsx"].includes(lang);
  // `.ts` is excluded because `<T>value` type assertions and `a <b ? 1 : 2`
  // comparisons are valid there and would be parsed as JSX.
  const jsx = ext !== ".ts" && !(ext === "" && lang === "ts");
  return {
    sourceType: "unambiguous",
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: true,
    attachComment: false,
    plugins: [jsx ? "jsx" : null, typescript ? "typescript" : null, ...extras].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

function jsxTagName(node) {
  if (!node) return "";
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") {
    return `${jsxTagName(node.object)}.${jsxTagName(node.property)}`;
  }
  if (node.type === "JSXNamespacedName") {
    return `${jsxTagName(node.namespace)}:${jsxTagName(node.name)}`;
  }
  return "";
}

function stringValueOf(node) {
  if (!node) return null;
  if (node.type === "StringLiteral" || node.type === "DirectiveLiteral") {
    return { value: node.value, start: node.start ?? node.range?.[0] ?? 0 };
  }
  if (node.type === "JSXExpressionContainer") return stringValueOf(node.expression);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    const first = node.quasis[0];
    if (first) return { value: first.value.cooked ?? first.value.raw, start: node.start };
  }
  return null;
}

function calleeName(callee) {
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    const object = calleeName(callee.object);
    const property = callee.property?.name || callee.property?.value;
    return object ? `${object}.${property}` : String(property || "");
  }
  return "";
}

/* Enter-only walker with a mutable context. A real `@babel/traverse` would be
 * another optional dependency for what amounts to one recursive function, and
 * `@babel/traverse` is a heavier dependency than the parser itself. */
function walkAst(ast, handlers) {
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;

    const descend = handlers.enter(node);
    if (descend === false) return;

    for (const key of Object.keys(node)) {
      if (SKIP_CHILD_KEYS.has(key)) continue;
      const child = node[key];
      if (child && typeof child === "object") visit(child);
    }

    if (handlers.exit) handlers.exit(node);
  };
  visit(ast);
}

function enterComponentName(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return node.id?.name || "";
  }
  if (node.type === "VariableDeclarator") {
    const init = node.init;
    // `const Card = () => {}`, `const Card = memo(() => {})`,
    // `const Card = forwardRef(...)` all declare a component.
    if (init && /Function|Arrow|CallExpression/.test(init.type)) {
      return node.id?.name || "";
    }
  }
  return "";
}

/* A class method is not a component. `class Panel { render() { return <x/> } }`
 * must report "Panel", not "render", so a method contributes no name of its
 * own and the enclosing class keeps winning. */
function declarationNameOf(node) {
  if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") return "";
  if (node.type === "ObjectMethod") return node.key?.name || node.key?.value || "";
  if (node.type === "ObjectProperty") {
    const key = node.key?.name ?? node.key?.value;
    return typeof key === "string" ? key : "";
  }
  if (node.type === "VariableDeclarator") return node.id?.name || "";
  return node.id?.name || "";
}

export function extractFromAst(ast, offset = 0) {
  const elements = [];
  const sites = [];
  const declarations = [];
  const state = { component: "", stack: [] };

  const pushSite = (kind, value, start, elementIndex = null, detail = "") => {
    const normalized = normalizeValue(value);
    if (normalized.length < minimumNeedleFor(kind)) return;
    sites.push({
      kind,
      value: normalized,
      start: start + offset,
      elementIndex,
      detail,
      // The enclosing component is recorded on every site so the scorer can
      // tell "this evidence is inside ProductCard" without re-walking.
      component: state.component,
    });
  };

  walkAst(ast, {
    enter(node) {
      const componentName = enterComponentName(node);
      if (componentName) {
        state.stack.push(state.component);
        state.component = componentName;
      }

      if (DECLARATION_TYPES.has(node.type)) {
        const name = declarationNameOf(node);
        if (name) {
          const start = node.id?.start ?? node.key?.start ?? node.start ?? 0;
          declarations.push({ name, kind: node.type, start: start + offset });
          pushSite("component-declaration", name, start, null, node.type);
          pushSite("identifier", name, start, null, node.type);
        }
      }

      if (node.type === "JSXElement" || node.type === "JSXFragment") {
        const opening = node.type === "JSXElement" ? node.openingElement : node;
        const tag = node.type === "JSXFragment" ? "" : jsxTagName(opening.name);
        const elementIndex = elements.length;
        const attributes = [];

        for (const attribute of opening.attributes || []) {
          if (attribute.type !== "JSXAttribute") continue;
          const name = jsxTagName(attribute.name);
          const resolved = stringValueOf(attribute.value);
          const kind = attributeSiteKind(name);
          attributes.push({
            name,
            value: resolved ? normalizeValue(resolved.value) : "",
            kind,
            start: attribute.start + offset,
            valueStart: resolved ? resolved.start + offset : attribute.start + offset,
            expression: attribute.value?.type === "JSXExpressionContainer",
          });
          if (resolved) {
            pushSite(kind, resolved.value, resolved.start, elementIndex, name);
            pushSite("string-literal", resolved.value, resolved.start, elementIndex, name);
          }
        }

        const textContent = (node.children || [])
          .filter((child) => child.type === "JSXText")
          .map((child) => child.value)
          .join(" ");

        elements.push({
          tag,
          component: state.component,
          start: node.start + offset,
          end: node.end + offset,
          selfClosing: Boolean(opening.selfClosing),
          attributes,
          textContent: normalizeValue(textContent),
          elementIndex,
        });

        if (normalizeValue(textContent).length >= 2) {
          pushSite("jsx-text", textContent, node.start, elementIndex, tag);
        }
        if (tag && /^[A-Z]|\./.test(tag)) {
          pushSite("component-usage", tag, opening.name.start ?? node.start, elementIndex, tag);
          pushSite("identifier", tag, opening.name.start ?? node.start, elementIndex, tag);
        }
        return true;
      }

      if (node.type === "CallExpression") {
        const name = calleeName(node.callee);
        const last = name.split(".").pop();
        if (I18N_CALLEES.has(last)) {
          const first = stringValueOf(node.arguments?.[0]);
          if (first) pushSite("i18n-call", first.value, first.start, null, name);
        }
        return true;
      }

      if (node.type === "ObjectProperty") {
        const key = node.key?.value ?? node.key?.name;
        const resolved = stringValueOf(node.value);
        if (typeof key === "string" && resolved) {
          pushSite("i18n-object-key", key, node.key.start ?? node.start, null, "object key");
        }
        return true;
      }

      if (node.type === "StringLiteral" || node.type === "DirectiveLiteral") {
        pushSite("string-literal", node.value, node.start ?? 0, null, node.type);
        return true;
      }

      if (node.type === "TemplateElement") {
        pushSite(
          "string-literal",
          node.value?.cooked ?? node.value?.raw,
          node.start ?? 0,
          null,
          "template",
        );
        return true;
      }

      if (node.type === "JSXText") {
        pushSite("jsx-text", node.value, node.start, null, "JSXText");
        return true;
      }

      if (node.type === "Identifier" || node.type === "JSXIdentifier") {
        pushSite("identifier", node.name, node.start ?? 0, null, node.type);
        return true;
      }

      return true;
    },
    exit(node) {
      if (enterComponentName(node)) state.component = state.stack.pop() ?? "";
    },
  });

  return { elements, sites, declarations };
}

// ---------------------------------------------------------------------------
// Lexical extraction
// ---------------------------------------------------------------------------

function extractFromText(text, ext, offset = 0) {
  const comments = scanComments(text);
  const elements = [];
  const sites = [];
  const declarations = [];

  const pushSite = (kind, value, start, elementIndex = null, detail = "") => {
    const normalized = normalizeValue(value);
    if (normalized.length < minimumNeedleFor(kind)) return;
    sites.push({
      kind,
      value: normalized,
      start: start + offset,
      elementIndex,
      detail,
      // The lexical engine cannot attribute a site to a component, so this
      // stays empty and scope-based corroboration simply does not fire.
      component: "",
    });
  };

  if (MARKUP_EXTENSIONS.has(ext)) {
    const regions = scanTagRegions(text, comments);
    const elementByRegionStart = new Map();

    for (const region of regions) {
      if (region.closing) continue;
      const elementIndex = elements.length;
      elementByRegionStart.set(region.start, elementIndex);
      const attributes = region.attributes.map((attribute) => {
        const kind = attributeSiteKind(attribute.name);
        return {
          name: attribute.name,
          value: normalizeValue(attribute.value),
          kind,
          start: attribute.start + offset,
          valueStart: attribute.valueStart + offset,
          expression: attribute.expression,
        };
      });

      for (const attribute of region.attributes) {
        if (!attribute.value) continue;
        const kind = attributeSiteKind(attribute.name);
        pushSite(kind, attribute.value, attribute.valueStart, elementIndex, attribute.name);
        pushSite("string-literal", attribute.value, attribute.valueStart, elementIndex, attribute.name);
      }

      elements.push({
        tag: region.tag,
        component: "",
        start: region.start + offset,
        end: region.end + offset,
        selfClosing: region.selfClosing,
        attributes,
        textContent: "",
        elementIndex,
      });

      if (/^[A-Z]|\./.test(region.tag)) {
        pushSite("component-usage", region.tag, region.nameEnd, elementIndex, region.tag);
        pushSite("identifier", region.tag, region.nameEnd, elementIndex, region.tag);
      }
    }

    /* `scanTextRuns` reports `afterRegion` as an index into the array it was
     * given — which includes closing tags. Resolving through the region list
     * and then through the start-offset map is what attributes each text run
     * to the element that actually opened before it. Indexing the filtered
     * list directly would misattribute every run after the first closing tag.
     */
    for (const run of scanTextRuns(text, regions, comments)) {
      const owner = regions[run.afterRegion];
      const elementIndex =
        owner && !owner.closing ? elementByRegionStart.get(owner.start) ?? null : null;
      if (elementIndex !== null) {
        elements[elementIndex].textContent = normalizeValue(run.value);
      }
      pushSite("jsx-text", run.value, run.start, elementIndex, "text run");
    }
  }

  if (STYLE_EXTENSIONS.has(ext)) {
    for (const selector of scanCssSelectors(text, comments)) {
      pushSite("css-selector", selector.value, selector.start, null, selector.marker);
    }
  }

  for (const literal of scanStrings(text, comments)) {
    pushSite("string-literal", literal.value, literal.start, null, "literal");
    // `<div data-testid="x">` inside a string is not useful, but an attribute
    // written in a template string is. Keep the value reachable by attribute
    // kind as well, at string strength.
  }

  for (const identifier of scanIdentifiers(text, comments)) {
    pushSite("identifier", identifier.value, identifier.start, null, "identifier");
  }

  // `function Name` / `const Name =` / `class Name` — enough to answer a
  // component-name query without a parser.
  const declarationPattern =
    /(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)|(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  let match;
  while ((match = declarationPattern.exec(text))) {
    const name = match[1] || match[2];
    const start = match.index + match[0].indexOf(name);
    declarations.push({ name, kind: match[1] ? "FunctionDeclaration" : "VariableDeclarator", start: start + offset });
    pushSite("component-declaration", name, start, null, "lexical");
  }

  return { elements, sites, declarations };
}

// ---------------------------------------------------------------------------
// File analysis
// ---------------------------------------------------------------------------

/* For a `.vue` file the script block is parsed and the template block is
 * scanned lexically, because a template is not JavaScript. Both contribute
 * offsets into the *same* text, so the line table is built once for the whole
 * file and every site carries an absolute offset.
 *
 * The reported `mode` is `ast` only when every script block parsed. A `.vue`
 * file whose script fell back to lexical scanning must not advertise AST
 * precision, because the confidence cap keys off exactly that.
 */
function analyzeVueFile(text, options) {
  const blocks = splitVueSfc(text);
  const elements = [];
  const sites = [];
  const declarations = [];
  const notes = [];

  const scriptBlocks = blocks.filter((block) => block.tag === "script");
  const templateBlocks = blocks.filter((block) => block.tag === "template");
  let allScriptsParsed = scriptBlocks.length > 0;

  if (scriptBlocks.length === 0) notes.push("no script block");

  for (const block of scriptBlocks) {
    let parsed = false;
    if (options.parser && block.content.length <= MAX_PARSE_BYTES) {
      try {
        const ast = options.parser.parse(
          block.content,
          parserOptionsFor("", block.lang, options.plugins),
        );
        const extracted = extractFromAst(ast, block.contentStart);
        elements.push(...extracted.elements);
        sites.push(...extracted.sites);
        declarations.push(...extracted.declarations);
        parsed = true;
      } catch (error) {
        notes.push(`parse failed: ${error.message}`);
      }
    }
    if (!parsed) {
      allScriptsParsed = false;
      const extracted = extractFromText(block.content, ".js", block.contentStart);
      elements.push(...extracted.elements);
      sites.push(...extracted.sites);
      declarations.push(...extracted.declarations);
    }
  }

  for (const block of templateBlocks) {
    const extracted = extractFromText(block.content, ".html", block.contentStart);
    const base = elements.length;
    for (const element of extracted.elements) {
      element.elementIndex = base + element.elementIndex;
      elements.push(element);
    }
    for (const site of extracted.sites) {
      site.elementIndex = site.elementIndex === null ? null : base + site.elementIndex;
      sites.push(site);
    }
    declarations.push(...extracted.declarations);
  }

  return {
    elements,
    sites,
    declarations,
    notes,
    mode: allScriptsParsed ? "ast" : "lexical",
  };
}

export function analyzeFile(text, ext, options = {}) {
  const result = { elements: [], sites: [], declarations: [], notes: [], mode: "lexical" };

  if (STYLE_EXTENSIONS.has(ext)) {
    const extracted = extractFromText(text, ext);
    return { ...result, ...extracted };
  }

  if (ext === ".vue") {
    const extracted = analyzeVueFile(text, options);
    return { ...result, ...extracted };
  }

  if (options.parser && SCRIPT_EXTENSIONS.has(ext) && text.length <= MAX_PARSE_BYTES) {
    try {
      const ast = options.parser.parse(text, parserOptionsFor(ext, "", options.plugins));
      const extracted = extractFromAst(ast);
      return { ...result, ...extracted, mode: "ast" };
    } catch (error) {
      result.notes.push(`parse failed: ${error.message}`);
    }
  }

  const extracted = extractFromText(text, ext);
  return { ...result, ...extracted, mode: "lexical" };
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const LOCALE_SEGMENT =
  /^(locales?|i18n|lang|langs|languages|messages|translations|intl|locale-data)$/i;
const LOCALE_FILENAME = /^([a-z]{2,3})([-_][A-Za-z]{2,4})?$/i;
const SKIP_DIRECTORIES = new Set([
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

export function looksLikeLocalePath(relative) {
  const segments = String(relative).split("/");
  const file = segments[segments.length - 1] || "";
  const directoryMatch = segments
    .slice(0, -1)
    .some((segment) => LOCALE_SEGMENT.test(segment));
  return directoryMatch || LOCALE_FILENAME.test(file.replace(/\.json$/i, ""));
}

export function flattenMessages(value, prefix = "", out = []) {
  if (typeof value === "string") {
    if (prefix) out.push({ key: prefix, text: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenMessages(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    // i18next ICU style: { "key": { "message": "..." } }
    const leafKeys = ["message", "other", "default", "text", "value"];
    if (
      keys.length === 1 &&
      leafKeys.includes(keys[0]) &&
      typeof value[keys[0]] === "string"
    ) {
      out.push({ key: prefix, text: value[keys[0]] });
      return out;
    }
    for (const key of keys) {
      flattenMessages(value[key], prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

export async function collectLocaleFiles(root, options = {}) {
  const { maxFiles = 60, maxBytes = 262144, maxTotalBytes = 4_000_000 } = options;
  const found = [];
  const queue = [root];
  let total = 0;

  while (queue.length > 0 && found.length < maxFiles) {
    const current = queue.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        queue.push(absolute);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".json")) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!looksLikeLocalePath(relative)) continue;
      let info;
      try {
        info = await stat(absolute);
      } catch {
        continue;
      }
      if (info.size === 0 || info.size > maxBytes) continue;
      if (total + info.size > maxTotalBytes) continue;
      total += info.size;
      found.push({ absolute, relative, locale: localeOf(relative) });
    }
  }

  return found;
}

function localeOf(relative) {
  const file = relative.split("/").pop() || "";
  const stem = file.replace(/\.json$/i, "");
  return LOCALE_FILENAME.test(stem) ? stem.toLowerCase() : "default";
}

export function buildI18nIndex(records) {
  const byText = new Map();
  const byKey = new Map();

  const add = (map, key, value) => {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  };

  let entries = 0;
  for (const record of records) {
    let messages;
    try {
      messages = JSON.parse(record.text ?? "{}");
    } catch {
      continue;
    }
    if (!messages || typeof messages !== "object") continue;

    for (const { key, text } of flattenMessages(messages)) {
      const normalized = normalizeValue(text);
      if (normalized.length === 0) continue;
      entries += 1;
      const entry = { key, text: normalized, locale: record.locale, file: record.relative };
      add(byText, normalized, entry);
      const lower = normalized.toLowerCase();
      if (lower !== normalized) add(byText, lower, entry);
      add(byKey, key, entry);
    }
  }

  return { byText, byKey, entries, files: records.length };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/* Site kinds that match a value wherever it appears rather than at a known
 * position. A one- or two-character needle against these produces pure noise —
 * every `id` and `i` in the file — so they carry a higher minimum length than
 * the precise kinds, where a short value like `data-testid="w"` is a perfectly
 * good answer.
 */
export const LOOSE_SITE_KINDS = new Set(["string-literal", "identifier", "css-selector"]);

export const MIN_LOOSE_NEEDLE = 3;

/* Applied at both ends: extraction drops values that can never be looked up, so
 * the buckets stay small, and lookup re-checks because a caller can ask for a
 * shorter needle than any site would have.
 */
export function minimumNeedleFor(kind) {
  return LOOSE_SITE_KINDS.has(kind) ? MIN_LOOSE_NEEDLE : 1;
}

function siteKey(kind, value) {
  return `${kind}\u0000${value}`;
}

export async function createSymbolIndex(options = {}) {
  const startedAt = Date.now();
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const files = options.files || [];
  const localeFiles = options.localeFiles || [];
  const parserInfo =
    options.parser !== undefined
      ? {
          parser: options.parser,
          from: options.parser ? "injected" : null,
          plugins: options.parser ? resolvePluginExtras(options.parser) : [],
          failures: [],
        }
      : loadParser([path.join(root, "node_modules"), root]);

  const parser = parserInfo.parser;
  const records = new Map();
  const siteBuckets = new Map();
  const parseErrors = [];
  const stats = {
    files: 0,
    parsed: 0,
    lexical: 0,
    failed: 0,
    elements: 0,
    sites: 0,
    bytes: 0,
    engine: parser ? "ast" : "lexical",
  };

  for (const entry of files) {
    const absolute = typeof entry === "string" ? entry : entry.path;
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    let text = typeof entry === "string" ? null : entry.text;
    if (text === null) {
      try {
        text = await readFile(absolute, "utf8");
      } catch (error) {
        parseErrors.push({ file: relative, message: `read failed: ${error.code || error.message}` });
        continue;
      }
    }

    const ext = path.extname(relative).toLowerCase();
    const extracted = analyzeFile(text, ext, { parser, plugins: parserInfo.plugins });
    const lineTable = buildLineTable(text);

    const record = {
      absolute,
      relative,
      ext,
      text,
      lineTable,
      mode: extracted.mode,
      notes: extracted.notes,
      elements: extracted.elements,
      sites: extracted.sites,
      declarations: extracted.declarations,
    };
    records.set(relative, record);

    stats.files += 1;
    stats.bytes += text.length;
    stats.elements += record.elements.length;
    stats.sites += record.sites.length;
    if (record.mode === "ast") stats.parsed += 1;
    else stats.lexical += 1;
    for (const note of record.notes) {
      if (note.startsWith("parse failed")) {
        stats.failed += 1;
        parseErrors.push({ file: relative, message: note });
      }
    }

    for (const site of record.sites) {
      const key = siteKey(site.kind, site.value);
      let bucket = siteBuckets.get(key);
      if (!bucket) {
        bucket = [];
        siteBuckets.set(key, bucket);
      }
      bucket.push({
        relative,
        start: site.start,
        elementIndex: site.elementIndex,
        detail: site.detail,
        component: site.component || "",
      });
    }
  }

  /* `engine` reports what actually produced the sites, not what was available.
   * A parser that resolves but throws on every file — a version mismatch, a
   * plugin conflict — leaves every file lexically scanned, and calling that
   * "AST" in the artifact would be a lie. `parser.available` carries the loader
   * story separately.
   */
  stats.engine = parser && stats.parsed > 0 ? "ast" : "lexical";

  const localeRecords = [];
  for (const entry of localeFiles) {
    if (entry.text !== undefined) {
      localeRecords.push(entry);
      continue;
    }
    try {
      const text = await readFile(entry.absolute ?? entry.path, "utf8");
      localeRecords.push({ ...entry, text });
    } catch {
      /* A locale file that cannot be read simply contributes nothing. */
    }
  }

  const i18n = buildI18nIndex(localeRecords);
  stats.locales = i18n.files;
  stats.i18nEntries = i18n.entries;
  stats.ms = Date.now() - startedAt;

  const index = {
    root,
    engine: stats.engine,
    stats,
    parseErrors,
    parser: { available: Boolean(parser), from: parserInfo.from, failures: parserInfo.failures },
    records,
    i18n,

    /* Every site whose kind and value match exactly. Case-insensitive matching
     * is a second pass so the exact hit always wins the deduplication.
     *
     * The minimum needle length depends on the kind: a precise kind answers a
     * one-character `data-testid`, a loose kind would answer every identifier
     * in the repository.
     */
    sitesOf(kind, value) {
      const normalized = normalizeValue(value);
      const minimum = minimumNeedleFor(kind);
      if (normalized.length < minimum) return [];
      const exact = siteBuckets.get(siteKey(kind, normalized));
      if (exact && exact.length > 0) return exact;
      return siteBuckets.get(siteKey(kind, normalized.toLowerCase())) || [];
    },

    reverseLookup(text) {
      const normalized = normalizeValue(text);
      if (normalized.length < 2) return [];
      const direct = i18n.byText.get(normalized) || i18n.byText.get(normalized.toLowerCase());
      if (direct && direct.length > 0) return direct;
      // The annotation text is clipped before it reaches here, so a locale
      // value can legitimately be longer than the needle. Only attempt the
      // containment pass on indexes small enough for it to stay cheap.
      if (normalized.length < 4 || i18n.byText.size > 5000) return [];
      const lower = normalized.toLowerCase();
      const found = [];
      for (const [key, entries] of i18n.byText) {
        if (key.length <= lower.length) continue;
        if (key.toLowerCase().includes(lower)) found.push(...entries);
        if (found.length >= 4) break;
      }
      return found.slice(0, 4);
    },

    /* Which element encloses a source position — used to describe an exact
     * annotation in terms the agent can act on ("<article> inside
     * ProductCard") instead of just a line number.
     *
     * Two modes, because the two callers know different things:
     *
     * - `column > 0`: an indexed site knows its exact offset, so take the
     *   smallest element containing it. This is what makes `<h3>{t("x")}</h3>`
     *   resolve to the `<h3>` rather than the enclosing `<article>`.
     * - `column === 0`: a `sourceLine` from development metadata has no column.
     *   Falling back to the line start would pick the *parent* — the element
     *   opening mid-line is invisible to a column-0 lookup. So prefer the
     *   smallest element that opens on that line, and only if there is none
     *   fall back to containment.
     */
    describeAt(relative, line, column = 0) {
      const record = records.get(relative);
      if (!record) return null;
      const lineStart = record.lineTable[Math.max(0, line - 1)] ?? 0;
      const offset = lineStart + Math.max(0, column);

      const smallest = (predicate) => {
        let best = null;
        for (const element of record.elements) {
          if (!predicate(element)) continue;
          if (!best || element.end - element.start < best.end - best.start) best = element;
        }
        return best;
      };

      const containing = smallest((element) => element.start <= offset && element.end >= offset);
      const startingHere =
        column > 0
          ? null
          : smallest(
              (element) =>
                positionAt(record.lineTable, element.start).line === line && element.tag !== "",
            );

      const best =
        column > 0
          ? containing
          : startingHere ?? containing;

      if (!best) return null;
      const testId = best.attributes.find((attribute) => attribute.kind === "jsx-attribute-testid");
      const start = positionAt(record.lineTable, best.start);
      const end = positionAt(record.lineTable, best.end);
      return {
        tag: best.tag,
        component: best.component,
        testId: testId?.value || "",
        line: start.line,
        endLine: end.line,
      };
    },

    positionOf(relative, offset) {
      const record = records.get(relative);
      if (!record) return { line: 1, column: 0 };
      return positionAt(record.lineTable, offset);
    },
  };

  return index;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/* Each annotation field becomes one or more queries. `sites` lists the site
 * kinds that count as a precise answer; `fallback` lists kinds that still
 * count but at a discount, so a `data-testid` value that only ever appears as
 * a plain string keeps some recall without outranking the real attribute.
 *
 * Scores are the original weights, kept stable so confidence thresholds and
 * existing behaviour stay comparable. `i18n-key` is new and sits just below
 * `source-component`: it is a strong, specific signal, but it goes through one
 * indirection (visible text -> locale value -> key -> call site).
 */
export function annotationQueries(annotation, index) {
  const target = annotation.target || {};
  const attributes = target.attributes || {};
  const queries = [];

  /* `minimum` is 1 for identity queries — `data-testid="w"` and `id="a"` are
   * legal and unambiguous — and 2 for the rest, where a single character is
   * more likely to be a clipping accident than a real target.
   */
  const push = (kind, value, score, sites, fallback = {}, note = "", minimum = 2) => {
    const needle = normalizeValue(value).slice(0, 240);
    if (needle.length < minimum) return;
    queries.push({ kind, value: needle, score, sites, fallback, note });
  };

  push(
    "test-id",
    target.testId || attributes["data-testid"] || attributes["data-test-id"],
    100,
    { "jsx-attribute-testid": 1 },
    { "string-literal": 0.35, identifier: 0.35 },
    "",
    1,
  );
  push(
    "source-component",
    target.componentName,
    92,
    { "component-declaration": 1, "component-usage": 0.9 },
    { "string-literal": 0.3 },
    "",
    2,
  );
  push(
    "element-id",
    target.id,
    86,
    { "jsx-attribute-id": 1 },
    { "string-literal": 0.35, "css-selector": 0.5 },
    "",
    1,
  );
  push(
    "aria-label",
    target.accessibleName || attributes["aria-label"],
    76,
    { "jsx-attribute-aria": 1 },
    { "string-literal": 0.4 },
  );
  push(
    "visible-text",
    target.text,
    64,
    { "jsx-text": 1 },
    { "string-literal": 0.5, identifier: 0.4 },
  );
  push(
    "placeholder",
    attributes.placeholder,
    60,
    { "jsx-attribute-placeholder": 1 },
    { "string-literal": 0.4 },
  );
  push(
    "href",
    attributes.href,
    54,
    { "jsx-attribute-href": 1 },
    { "string-literal": 0.4 },
  );

  // Localized text never appears in source. Reverse-map it to a key first.
  const text = target.text;
  if (text && index) {
    const hits = index.reverseLookup(text);
    const seen = new Set();
    for (const hit of hits) {
      if (seen.has(hit.key)) continue;
      seen.add(hit.key);
      queries.push({
        kind: "i18n-key",
        value: hit.key,
        score: 88,
        sites: { "i18n-call": 1, "i18n-object-key": 1 },
        fallback: { "string-literal": 0.9 },
        note: `from visible text ${JSON.stringify(normalizeValue(text))} (${hit.locale})`,
        origin: hit,
      });
    }
  }

  return queries;
}

function confidenceFor(score, contributions, fileMode) {
  const precise = contributions.some(
    (contribution) => (SITE_WEIGHTS[contribution.siteKind] ?? 0) >= 1,
  );
  let level = score >= 100 && precise ? "high" : score >= 70 ? "medium" : "low";
  /* Lexical comment detection is a heuristic, so a lexically scanned file can
   * never claim to have ruled out a comment. The cap keys off the *file's*
   * mode, not the repository-wide engine: a `.css` file is lexically scanned
   * even when a parser was found, and a `.tsx` file that failed to parse is
   * lexically scanned even though every other file in the repo parsed.
   */
  if (fileMode !== "ast" && level === "high") level = "medium";
  return level;
}

/* One human-readable line per evidence kind. The `siteKind @line:column`
 * suffix is the part that makes a wrong match diagnosable: it says not just
 * "this string was somewhere in the file" but "this was the `data-testid`
 * attribute on line 18", so a reviewer can check the claim in one jump.
 */
function evidenceLine(contribution) {
  const { query, siteKind, position } = contribution;
  const suffix = query.note
    ? ` (${query.note})`
    : ` (${siteKind} @${position.line}:${position.column})`;
  return `${query.kind}: ${JSON.stringify(query.value)}${suffix}`;
}

export function resolveAnnotationCandidates(index, annotation, options = {}) {
  const { explicit = null, limit = 5 } = options;

  if (annotation.kind === "redact") return [];

  const queries = annotationQueries(annotation, index);
  const perFile = new Map();

  for (const query of queries) {
    const preciseHits = new Map();
    for (const [siteKind, weight] of Object.entries(query.sites || {})) {
      for (const site of index.sitesOf(siteKind, query.value)) {
        const existing = preciseHits.get(site.relative);
        if (!existing || weight > existing.weight) {
          preciseHits.set(site.relative, { ...site, siteKind, weight });
        }
      }
    }

    const chosen = new Map(preciseHits);
    // A fallback only competes in files where no precise site matched, so the
    // real attribute always outranks the same string appearing elsewhere.
    for (const [siteKind, weight] of Object.entries(query.fallback || {})) {
      for (const site of index.sitesOf(siteKind, query.value)) {
        if (chosen.has(site.relative)) continue;
        chosen.set(site.relative, { ...site, siteKind, weight });
      }
    }

    for (const hit of chosen.values()) {
      let entry = perFile.get(hit.relative);
      if (!entry) {
        entry = { score: 0, contributions: [] };
        perFile.set(hit.relative, entry);
      }
      const gained = query.score * hit.weight;
      entry.score += gained;
      entry.contributions.push({
        query,
        siteKind: hit.siteKind,
        weight: hit.weight,
        offset: hit.start,
        elementIndex: hit.elementIndex,
        detail: hit.detail,
        component: hit.component || "",
        relative: hit.relative,
        position: index.positionOf(hit.relative, hit.start),
        gained,
      });
    }
  }

  const candidates = [];

  for (const [relative, entry] of perFile) {
    const record = index.records.get(relative);
    if (!record) continue;

    let score = entry.score;
    const evidence = [];
    const kindsSeen = new Set();

    /* Corroboration: how many independent evidence kinds converge on one
     * place. Two shapes count, and the second is the one that fires:
     *
     *  - kinds landing on the *same element* (the test id and the text are
     *    both on the `<button>`);
     *  - a kind landing on an element plus a different kind landing anywhere
     *    inside the *same component scope* — the usual case, because a
     *    component is declared at the top of the file and the element the user
     *    pointed at is further down.
     *
     * Grouping by element index alone was the obvious implementation and it
     * almost never fired: a `component-declaration` site has no element, so
     * the test id and the component name never shared a group. A rule that
     * silently never applies is worse than no rule, because it reads as if it
     * is doing something.
     */
    const byElement = new Map();
    for (const contribution of entry.contributions) {
      if (contribution.elementIndex === null || contribution.elementIndex === undefined) continue;
      const list = byElement.get(contribution.elementIndex) || [];
      list.push(contribution);
      byElement.set(contribution.elementIndex, list);
    }

    let bestElement = null;
    let bestElementKinds = 0;
    for (const [elementIndex, list] of byElement) {
      const kinds = new Set(list.map((item) => item.query.kind));
      if (kinds.size > bestElementKinds) {
        bestElementKinds = kinds.size;
        bestElement = { elementIndex, list, kinds };
      }
    }

    const componentName = normalizeValue(annotation.target?.componentName);
    let corroborated = null;

    if (bestElement) {
      const element = record.elements[bestElement.elementIndex];
      const scope = element?.component || "";
      const kinds = new Set(bestElement.kinds);

      for (const contribution of entry.contributions) {
        if (contribution.elementIndex === bestElement.elementIndex) continue;
        const sameScope =
          (scope !== "" && contribution.component === scope) ||
          (componentName !== "" &&
            contribution.query.kind === "source-component" &&
            contribution.query.value === componentName);
        if (sameScope) kinds.add(contribution.query.kind);
      }

      if (kinds.size >= 2) {
        const bonus = 12 * (kinds.size - 1);
        score += bonus;
        corroborated = {
          kinds: [...kinds],
          bonus,
          tag: element?.tag || "",
          component: scope,
        };
        evidence.push(
          `corroborated: ${kinds.size} independent kinds agree on <${element?.tag || "?"}> (+${bonus})`,
        );
      }
    }

    // The annotation named a component and the evidence landed inside it.
    if (componentName && bestElement) {
      const element = record.elements[bestElement.elementIndex];
      if (element && element.component === componentName) {
        score += 10;
        evidence.push(`component-scope: <${element.tag}> is inside ${componentName} (+10)`);
      }
    }

    /* Which element to point at. The corroborated one wins because two
     * independent kinds of evidence agreeing on it is the strongest thing
     * this resolver can know. Failing that, the element of the highest-scoring
     * contribution. Failing that, no element — a bare declaration or literal
     * match is a legitimate answer and must not be dressed up as one. */
    const ranked = [...entry.contributions].sort((left, right) => right.gained - left.gained);
    const anchorElementIndex =
      bestElement?.elementIndex ??
      ranked.find((item) => item.elementIndex !== null && item.elementIndex !== undefined)
        ?.elementIndex ??
      null;
    const element =
      anchorElementIndex === null ? null : record.elements[anchorElementIndex] ?? null;

    // The element's opening tag is what a reader wants, not the attribute's
    // own offset — "line 18" beats "line 18, column 26" when scanning a file.
    const anchorOffset = element ? element.start : ranked[0]?.offset ?? 0;
    const position = index.positionOf(relative, anchorOffset);
    const endLine = element ? index.positionOf(relative, element.end).line : position.line;

    for (const contribution of ranked) {
      if (kindsSeen.has(contribution.query.kind)) continue;
      kindsSeen.add(contribution.query.kind);
      evidence.push(evidenceLine(contribution));
    }

    const testIdAttribute = element?.attributes?.find(
      (attribute) => attribute.kind === "jsx-attribute-testid",
    );

    /* A call-site or declaration match has no element of its own, but it is
     * still *inside* one. Reporting "t('product.card.title') on line 10" alone
     * makes the agent read the file to learn that line 10 is the heading; the
     * enclosing element says so directly. The reported line stays the precise
     * site — that is what the agent has to edit.
     */
    const enclosing = element ? null : index.describeAt(relative, position.line, position.column);
    const described = element
      ? {
          tag: element.tag,
          component: element.component,
          testId: testIdAttribute?.value || "",
        }
      : enclosing
        ? { tag: enclosing.tag, component: enclosing.component, testId: enclosing.testId }
        : null;

    candidates.push({
      file: relative,
      line: position.line,
      column: position.column,
      endLine,
      score: Math.round(score),
      confidence: confidenceFor(score, entry.contributions, record.mode),
      evidence,
      resolver: record.mode,
      fileMode: record.mode,
      element: described,
      enclosing: enclosing ? { tag: enclosing.tag, component: enclosing.component } : null,
      corroborated: corroborated
        ? { kinds: corroborated.kinds, bonus: corroborated.bonus, tag: corroborated.tag }
        : null,
      i18nKey:
        entry.contributions.find((contribution) => contribution.query.kind === "i18n-key")?.query
          .value || null,
    });
  }

  if (explicit) {
    candidates.push(explicit);
  }

  return candidates.sort((left, right) => right.score - left.score).slice(0, limit);
}
