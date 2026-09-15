/* SymbUI anchor injection core.
 *
 * The entire decision of "should this element carry a source anchor, and what
 * exactly should the anchor say" lives in one pure function. The AST adapters
 * (Babel for JSX/TSX, the Vue compiler for SFC templates) stay thin: they
 * extract a descriptor, call planInjection, and write the result into the AST.
 * Nothing in this file touches an AST, a filesystem, a bundler, or a network,
 * which is why every rule below is directly unit-testable.
 *
 * The attribute contract is fixed by the runtime probe, which already reads:
 *
 *   data-ui-source                     -> "src/Card.tsx:12" or "src/Card.tsx:12:7"
 *   data-source-line / data-ui-source-line -> line, when it is not inline
 *   data-component                     -> owning component name
 *
 * See assets/inventory-probe.js (`attributeSource`) and assets/overlay.js.
 *
 * Why build-time injection at all: the runtime probe can recover an anchor from
 * React's `_debugSource` fiber or Vue's `type.__file`, but that only works when
 * the framework's own dev plugin is active, it reports the *component* rather
 * than the element, and it silently disappears in a production-mode dev server.
 * Writing the anchor into the markup makes coverage total and independent of
 * framework internals. The anchor is the single highest-value signal in the
 * whole pipeline: it is what lets the revision diff tell "this card's price
 * changed" apart from "a card was inserted above and everything shifted".
 */

"use strict";

/* No `require` of any kind, including node builtins, and that is a hard
 * constraint rather than a style preference.
 *
 * Bundlers load plugin configs by bundling them. Vite bundles `vite.config.mjs`
 * with esbuild into an ES module, where every CommonJS `require("path")` becomes
 * a shim that throws `Dynamic require of "path" is not supported`. A single
 * builtin require anywhere in this file's import graph takes the whole config
 * down, so path handling is done with plain string code below.
 *
 * The upside is that these helpers are deterministic across platforms and
 * directly testable, which `path` never was.
 */

/* --------------------------------------------------------------- path bits */

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function isAbsolutePath(value) {
  var candidate = toPosix(value);
  if (candidate.charAt(0) === "/") return true;
  return /^[A-Za-z]:\//.test(candidate);
}

/* Collapse `.` and `..` segments and normalize separators, keeping whatever
 * root prefix was there. Mirrors `path.normalize` for the shapes a bundler
 * hands us, without touching the filesystem or the working directory.
 */
function collapsePath(value) {
  var candidate = toPosix(value);
  var prefix = "";
  var rooted = candidate.match(/^([A-Za-z]:)?\//);
  if (rooted) {
    prefix = (rooted[1] || "") + "/";
    candidate = candidate.slice(rooted[0].length);
  } else if (/^[A-Za-z]:/.test(candidate)) {
    prefix = candidate.slice(0, 2) + "/";
    candidate = candidate.slice(2);
  }

  var segments = candidate.split("/");
  var kept = [];
  for (var index = 0; index < segments.length; index += 1) {
    var segment = segments[index];
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
      else if (prefix === "") kept.push("..");
      continue;
    }
    kept.push(segment);
  }

  var joined = kept.join("/");
  if (prefix === "") return joined;
  return joined === "" ? prefix : prefix + joined;
}

/* Join and normalize. Unlike `path.resolve` this never consults the working
 * directory: every caller here has an absolute path already, and a silent
 * cwd dependency is exactly the kind of thing that makes an anchor wrong.
 */
function resolvePath() {
  var parts = [];
  for (var index = 0; index < arguments.length; index += 1) {
    var part = arguments[index];
    if (typeof part !== "string" || part === "") continue;
    if (isAbsolutePath(part)) parts = [part];
    else parts.push(part);
  }
  if (parts.length === 0) return "";
  return collapsePath(parts.join("/"));
}

function splitRoot(value) {
  var candidate = collapsePath(value);
  var rooted = candidate.match(/^([A-Za-z]:)?\//);
  if (rooted) return { root: (rooted[1] || "") + "/", rest: candidate.slice(rooted[0].length) };
  return { root: "", rest: candidate };
}

/* Relative path from `from` to `to`, or null when the two do not share a root.
 * Null rather than a best guess: an escaping path can never be matched against
 * the source index, so pretending it can is worse than admitting it cannot.
 */
function relativePath(from, to) {
  if (!from || !to) return null;
  var source = splitRoot(from);
  var target = splitRoot(to);
  if (source.root.toLowerCase() !== target.root.toLowerCase()) return null;

  var fromSegments = source.rest === "" ? [] : source.rest.split("/");
  var toSegments = target.rest === "" ? [] : target.rest.split("/");

  var common = 0;
  while (
    common < fromSegments.length &&
    common < toSegments.length &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1;
  }

  var out = [];
  for (var up = common; up < fromSegments.length; up += 1) out.push("..");
  for (var down = common; down < toSegments.length; down += 1) out.push(toSegments[down]);
  return out.join("/");
}

function pathBase(value) {
  var candidate = collapsePath(value);
  var cut = candidate.lastIndexOf("/");
  return cut >= 0 ? candidate.slice(cut + 1) : candidate;
}

function pathDir(value) {
  var candidate = collapsePath(value);
  var cut = candidate.lastIndexOf("/");
  if (cut < 0) return "";
  if (cut === 0) return "/";
  return candidate.slice(0, cut);
}

/* --------------------------------------------------------------- constants */

var ATTRIBUTE_SOURCE = "data-ui-source";
var ATTRIBUTE_COMPONENT = "data-component";

/* Alternate spellings the probe also accepts. If an element already carries one
 * of these, injecting ours would give the probe two disagreeing anchors, and
 * `attributeSource` reads `data-ui-source` first. Treat them as "already done".
 */
var FOREIGN_SOURCE_ATTRIBUTES = ["data-source-file", "data-ui-source-line", "data-source-line"];

/* Matched against whole path segments, never as a substring, so a project
 * directory named `src/build-helpers/` is not mistaken for build output.
 */
var DEFAULT_EXCLUDED_SEGMENTS = [
  "node_modules",
  ".git",
  ".symbui",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".netlify",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "bower_components",
];

/* Mirror of SKIP_TAGS in assets/inventory-probe.js, lowercased.
 *
 * This list is a hard constraint, not a preference: the probe never puts these
 * elements in the inventory, so an anchor on one can never be read back. It
 * would be pure DOM bloat, and worse, it would make coverage numbers lie. Keep
 * the two lists in step; the test suite asserts that they match.
 *
 * `template` is the one that bites in practice. A Vue template's structural
 * wrapper parses as an ordinary element with `tagType` 0, so the framework's own
 * classification says "host element" and only this list says no.
 */
var DEFAULT_SKIP_TAGS = [
  "script",
  "style",
  "meta",
  "link",
  "head",
  "title",
  "noscript",
  "template",
  "br",
  "wbr",
  "source",
  "track",
  "param",
  "base",
];

var REASONS = {
  ok: "An anchor was produced.",
  "no-descriptor": "The adapter passed no descriptor object.",
  production: "Anchors are development-only; a production build is being compiled.",
  "no-file": "The module has no usable absolute path, so no anchor can be formed.",
  "no-line": "The element has no trustworthy 1-based source line. A guessed line is worse than none: the diff aligns clusters by file:line, so a wrong line invents a phantom cluster.",
  "outside-root": "The module is not inside any configured root, so the anchor could not be made repository-relative.",
  "excluded-path": "The module lives in a dependency, build output, or a session artifact directory.",
  "component-element": "This is a component usage, not a host element. The anchor belongs on the element the component itself renders, in the component's own file.",
  "not-inventoried": "The runtime probe skips this tag, so an anchor here could never be read back. See SKIP_TAGS in assets/inventory-probe.js.",
  "symbui-host": "This element is part of the SymbUI overlay host and must never be inventoried.",
  "already-annotated": "The element already carries a source anchor, so injection is idempotent here.",
};

/* ----------------------------------------------------------------- helpers */

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

/* Normalize an attribute list that may be plain names, `{name}` objects, or the
 * AST nodes an adapter happened to have on hand.
 */
function attributeNames(list) {
  var names = [];
  if (!Array.isArray(list)) return names;
  for (var index = 0; index < list.length; index += 1) {
    var entry = list[index];
    if (typeof entry === "string") names.push(entry);
    else if (isObject(entry) && typeof entry.name === "string") names.push(entry.name);
    else if (isObject(entry) && isObject(entry.key) && typeof entry.key.name === "string") {
      names.push(entry.key.name);
    }
  }
  return names;
}

/* A host element is a real DOM/SVG tag. Everything else is a component
 * reference, a member expression (`Form.Item`), or a fragment.
 */
function isHostTag(tag) {
  if (typeof tag !== "string" || tag === "") return false;
  var name = tag;
  /* Namespaced tags (`svg:path`, `xlink:href`) keep their meaning after the
   * colon, so classify on the tail.
   */
  var colon = name.lastIndexOf(":");
  if (colon >= 0) name = name.slice(colon + 1);
  if (name === "") return false;
  /* Uppercase first letter means a component reference in JSX and in Vue
   * templates alike.
   */
  if (/^[A-Z]/.test(name)) return false;
  /* Dotted names are member expressions (`Form.Item`, `motion.div`). */
  if (name.indexOf(".") >= 0) return false;
  /* `<my-widget>` and `<div>` are both host elements. */
  return /^[a-z][a-zA-Z0-9-]*$/.test(name);
}

/* Tags the runtime probe refuses to inventory. An anchor on one of these is
 * unreadable, so writing it is wasted bytes and a dishonest coverage number.
 */
function isSkippedTag(tag, skipTags) {
  if (typeof tag !== "string" || tag === "") return false;
  var name = tag;
  var colon = name.lastIndexOf(":");
  if (colon >= 0) name = name.slice(colon + 1);
  return (skipTags || DEFAULT_SKIP_TAGS).indexOf(name.toLowerCase()) >= 0;
}

/* Strip anything that would break out of a double-quoted HTML attribute. The
 * component name ends up in markup, and a stray quote there would corrupt the
 * document rather than merely look wrong.
 */
function sanitizeAttributeValue(value, limit) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["'`<>&\\]/g, "")
    .trim()
    .slice(0, limit || 120);
}

/* Turn an absolute module path into a repository-relative one. Returns null
 * when the path is not under the root: a relative path that escapes upward
 * (`../other-package/...`) is never matchable against the source index, so it
 * must not be emitted as if it were.
 */
function relativize(file, root) {
  if (!file || !root) return null;
  var target = resolvePath(toPosix(file));
  var base = resolvePath(toPosix(root));
  if (!target || !base || target === base) return null;
  var relative = relativePath(base, target);
  if (!relative || relative === ".") return null;
  if (relative === ".." || relative.indexOf("../") === 0) return null;
  if (isAbsolutePath(relative)) return null;
  return relative;
}

function firstRelative(file, roots) {
  for (var index = 0; index < roots.length; index += 1) {
    var relative = relativize(file, roots[index]);
    if (relative) return { relative: relative, root: roots[index] };
  }
  return null;
}

function hasExcludedSegment(file, excluded) {
  var segments = toPosix(file).split("/");
  for (var index = 0; index < segments.length; index += 1) {
    if (excluded.indexOf(segments[index]) >= 0) return segments[index];
  }
  return null;
}

/* `line` must be a trustworthy positive integer. Strings are accepted because
 * some adapters hand back `node.loc.start.line` as a string after a round trip
 * through a source map.
 */
function normalizeLine(value) {
  var line = typeof value === "string" ? Number(value) : value;
  if (typeof line !== "number" || !Number.isFinite(line)) return null;
  if (!Number.isInteger(line)) line = Math.floor(line);
  if (line < 1) return null;
  return line;
}

function normalizeColumn(value) {
  var column = typeof value === "string" ? Number(value) : value;
  if (typeof column !== "number" || !Number.isFinite(column)) return null;
  if (!Number.isInteger(column)) column = Math.floor(column);
  if (column < 0) return null;
  return column;
}

/* An adapter that knows the framework's own rule (Vue's `isNativeTag`) can pass
 * an explicit boolean and skip our heuristic entirely.
 */
function resolveHost(descriptor) {
  if (typeof descriptor.host === "boolean") return descriptor.host;
  return isHostTag(descriptor.tag);
}

function resolveMode(descriptor) {
  var mode = descriptor.mode;
  if (mode === "production" || mode === "development") return mode;
  if (mode === "test") return "development";
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production") {
    return "production";
  }
  return "development";
}

function resolveRoots(descriptor, options) {
  var roots = [];
  function push(candidate) {
    if (typeof candidate === "string" && candidate !== "" && roots.indexOf(candidate) < 0) {
      roots.push(candidate);
    }
  }
  if (Array.isArray(descriptor.roots)) for (var index = 0; index < descriptor.roots.length; index += 1) push(descriptor.roots[index]);
  push(descriptor.root);
  push(descriptor.packageRoot);
  if (options && Array.isArray(options.roots)) for (var oi = 0; oi < options.roots.length; oi += 1) push(options.roots[oi]);
  if (options) {
    push(options.root);
    push(options.packageRoot);
  }
  return roots;
}

/* ------------------------------------------------------------ the decision */

function skip(reason, detail) {
  var plan = {
    inject: false,
    reason: reason,
    detail: detail || "",
    attributes: [],
    anchor: null,
  };
  return plan;
}

/* planInjection(descriptor, options) -> plan
 *
 * descriptor:
 *   tag           raw element name as written ("div", "Card", "svg:path", "")
 *   host          optional boolean override of the host-element heuristic
 *   file          absolute path of the module being compiled
 *   line          1-based line of the opening element
 *   column        0-based column, optional
 *   component     nearest enclosing component name, "" when unknown
 *   mode          "development" | "production" | "test" (defaults to NODE_ENV)
 *   root          repository root used to relativize `file`
 *   packageRoot   optional second root, tried after `root`
 *   roots         optional ordered list of roots, tried first
 *   attributes    attribute names already present on the element
 *   insideSymbuiHost  true when the element belongs to the SymbUI overlay
 *
 * options:
 *   roots           extra candidate roots, appended last
 *   exclude         replacement list of excluded path segments
 *   attributeSource override the source attribute name
 *   attributeComponent override the component attribute name
 *   emitComponent   set false to omit data-component
 *   emitColumn      set false to always write "file:line"
 */
function planInjection(descriptor, options) {
  var settings = options || {};

  if (!isObject(descriptor)) return skip("no-descriptor");

  if (resolveMode(descriptor) === "production") return skip("production");

  if (descriptor.insideSymbuiHost) return skip("symbui-host");

  var file = typeof descriptor.file === "string" ? descriptor.file : "";
  if (!file) return skip("no-file");

  var excluded = Array.isArray(settings.exclude) ? settings.exclude : DEFAULT_EXCLUDED_SEGMENTS;
  var excludedHit = hasExcludedSegment(file, excluded);
  if (excludedHit) return skip("excluded-path", excludedHit);

  var names = attributeNames(descriptor.attributes);
  var sourceAttribute = settings.attributeSource || ATTRIBUTE_SOURCE;
  if (names.indexOf(sourceAttribute) >= 0) return skip("already-annotated", sourceAttribute);
  for (var fi = 0; fi < FOREIGN_SOURCE_ATTRIBUTES.length; fi += 1) {
    if (names.indexOf(FOREIGN_SOURCE_ATTRIBUTES[fi]) >= 0) {
      return skip("already-annotated", FOREIGN_SOURCE_ATTRIBUTES[fi]);
    }
  }

  if (!resolveHost(descriptor)) return skip("component-element", String(descriptor.tag || ""));

  var skipTags = Array.isArray(settings.skipTags) ? settings.skipTags : DEFAULT_SKIP_TAGS;
  if (isSkippedTag(descriptor.tag, skipTags)) {
    return skip("not-inventoried", String(descriptor.tag));
  }

  var line = normalizeLine(descriptor.line);
  if (line === null) return skip("no-line");

  var roots = resolveRoots(descriptor, settings);
  if (roots.length === 0) return skip("outside-root", "no root configured");
  var placed = firstRelative(file, roots);
  if (!placed) return skip("outside-root", toPosix(file));

  var column = normalizeColumn(descriptor.column);
  var emitColumn = settings.emitColumn !== false && column !== null && column > 0;
  var value = placed.relative + ":" + line + (emitColumn ? ":" + column : "");

  var attributes = [{ name: sourceAttribute, value: value }];

  var component = settings.emitComponent === false ? "" : sanitizeAttributeValue(descriptor.component, 80);
  if (component) attributes.push({ name: settings.attributeComponent || ATTRIBUTE_COMPONENT, value: component });

  return {
    inject: true,
    reason: "ok",
    detail: "",
    attributes: attributes,
    anchor: {
      file: placed.relative,
      line: line,
      column: column,
      component: component,
      root: toPosix(placed.root),
    },
  };
}

/* Exposed so the plugin can print the rule table with `--debug` and so the
 * reference doc has a single source of truth.
 */
function describeReasons() {
  return Object.keys(REASONS).map(function (reason) {
    return { reason: reason, detail: REASONS[reason] };
  });
}

module.exports = {
  ATTRIBUTE_SOURCE: ATTRIBUTE_SOURCE,
  ATTRIBUTE_COMPONENT: ATTRIBUTE_COMPONENT,
  DEFAULT_EXCLUDED_SEGMENTS: DEFAULT_EXCLUDED_SEGMENTS,
  DEFAULT_SKIP_TAGS: DEFAULT_SKIP_TAGS,
  FOREIGN_SOURCE_ATTRIBUTES: FOREIGN_SOURCE_ATTRIBUTES,
  REASONS: REASONS,
  planInjection: planInjection,
  isHostTag: isHostTag,
  isSkippedTag: isSkippedTag,
  toPosix: toPosix,
  isAbsolutePath: isAbsolutePath,
  collapsePath: collapsePath,
  resolvePath: resolvePath,
  relativePath: relativePath,
  pathBase: pathBase,
  pathDir: pathDir,
  relativize: relativize,
  sanitizeAttributeValue: sanitizeAttributeValue,
  attributeNames: attributeNames,
  normalizeLine: normalizeLine,
  describeReasons: describeReasons,
};
