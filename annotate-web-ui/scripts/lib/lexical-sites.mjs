/* Lexical scanning primitives shared by both resolution engines.
 *
 * The symbol index runs in one of two modes. The AST engine parses a file and
 * reads element, attribute, and declaration positions straight off the tree.
 * The lexical engine has no parser and recovers the same information from the
 * raw text. Both must emit the *same site kinds* so the scorer never has to
 * branch on which engine produced a hit — otherwise every scoring rule would
 * need two implementations and they would drift apart.
 *
 * Nothing here imports a parser or an npm package. `node:` builtins only, and
 * actually not even those: this module is pure string work.
 *
 * Positions are byte offsets into the file's full text. Conversion to
 * line/column happens once, through `positionAt`, using a line table built
 * once per file. The previous implementation counted newlines with
 * `text.slice(0, index).split("\n").length` for every candidate, which is
 * O(file size) per query per file.
 */

/* A `/` can only begin a regular expression when the previous significant
 * character cannot end an expression. This is the standard heuristic; getting
 * it wrong matters less than it looks, because the only consumer of comment
 * ranges is the "do not match inside a comment" rule, and a mis-detected
 * regex can only over-extend a comment range, never invent one.
 */
const REGEX_MAY_FOLLOW = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "^",
  "~",
]);

const ATTRIBUTE_PATTERN =
  /([A-Za-z_:@#][-A-Za-z0-9_:.@#]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{[\s\S]*?\})/g;

const CSS_SELECTOR_PATTERN = /([.#][-A-Za-z_][-A-Za-z0-9_]*)/g;

const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

const TAG_NAME_PATTERN = /^[A-Za-z][-A-Za-z0-9_.:]*/;

/* Characters that may legitimately precede a `<` that opens a tag. Without
 * this guard every `a < b` comparison in a JS file would be scanned as an
 * element. */
const TAG_MAY_FOLLOW = /[\s(,;{}=>|&!?:+\-*[\]"'`]/;

/* A tag cannot run past this many characters. JSX attributes can be long, but
 * an unbounded scan on a malformed file would read to EOF for every `<`.
 */
const MAX_TAG_LENGTH = 4000;

export function buildLineTable(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/* 1-based line, 0-based column — the same convention Babel uses, so AST-derived
 * and lexically-derived positions are directly comparable.
 *
 * An offset past the end is not clamped. The binary search already keeps the
 * line index in range, and clamping to the last line start would report column
 * 0 for a position the caller knows is further along — which is strictly less
 * information than letting the column run past the line's length.
 */
export function positionAt(lineTable, index) {
  const clamped = Number.isFinite(index) ? Math.max(0, index) : 0;
  let low = 0;
  let high = lineTable.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineTable[mid] <= clamped) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: clamped - lineTable[low] };
}

export function inRanges(ranges, index) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (index < range[0]) high = mid - 1;
    else if (index >= range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

function skipQuoted(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote === "`" && char === "$" && text[index + 1] === "{") {
      index = skipBraces(text, index + 1);
      continue;
    }
    if (quote !== "`" && char === "\n") return index;
    index += 1;
  }
  return index;
}

function skipBraces(text, start) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipRegex(text, start) {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return start + 1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
    index += 1;
  }
  return index;
}

/* Returns sorted, non-overlapping [start, end) ranges. Strings are stepped
 * over so a `//` inside a URL literal is not read as a comment.
 */
export function scanComments(text) {
  const ranges = [];
  let index = 0;
  let previous = "";
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      ranges.push([start, index]);
      continue;
    }

    if (char === "/" && next === "*") {
      const start = index;
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
      ranges.push([start, index]);
      continue;
    }

    if (char === "<" && text.startsWith("<!--", index)) {
      const start = index;
      const close = text.indexOf("-->", index + 4);
      index = close === -1 ? text.length : close + 3;
      ranges.push([start, index]);
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(text, index, char);
      previous = char;
      continue;
    }

    if (char === "/" && (previous === "" || REGEX_MAY_FOLLOW.has(previous))) {
      index = skipRegex(text, index);
      previous = "/";
      continue;
    }

    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return ranges;
}

function decodeEscapes(raw) {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g, (
    match,
    _braced,
    codePoint,
    unicode,
    hex,
    plain,
  ) => {
    if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    if (plain === "n") return "\n";
    if (plain === "t") return "\t";
    if (plain === "r") return "\r";
    if (plain === "b") return "\b";
    if (plain === "f") return "\f";
    if (plain === "v") return "\v";
    if (plain === "0") return "\0";
    if (plain === undefined) return match;
    return plain;
  });
}

export function scanStrings(text, comments = []) {
  const sites = [];
  let index = 0;
  let cursor = 0;

  while (index < text.length) {
    while (cursor < comments.length && comments[cursor][1] <= index) cursor += 1;
    if (cursor < comments.length && index >= comments[cursor][0] && index < comments[cursor][1]) {
      index = comments[cursor][1];
      continue;
    }

    const char = text[index];
    if (char === "\"" || char === "'" || char === "`") {
      const end = skipQuoted(text, index, char);
      let raw = text.slice(index + 1, end);
      if (raw.endsWith(char)) raw = raw.slice(0, -1);
      sites.push({
        value: decodeEscapes(raw),
        start: index,
        end,
        quote: char,
      });
      index = end;
      continue;
    }
    index += 1;
  }

  return sites;
}

export function scanIdentifiers(text, comments = []) {
  const sites = [];
  let cursor = 0;
  IDENTIFIER_PATTERN.lastIndex = 0;
  let match;
  while ((match = IDENTIFIER_PATTERN.exec(text))) {
    while (cursor < comments.length && comments[cursor][1] <= match.index) cursor += 1;
    if (cursor < comments.length && match.index >= comments[cursor][0] && match.index < comments[cursor][1]) {
      continue;
    }
    sites.push({ value: match[0], start: match.index });
  }
  return sites;
}

export function scanCssSelectors(text, comments = []) {
  const sites = [];
  let cursor = 0;
  CSS_SELECTOR_PATTERN.lastIndex = 0;
  let match;
  while ((match = CSS_SELECTOR_PATTERN.exec(text))) {
    while (cursor < comments.length && comments[cursor][1] <= match.index) cursor += 1;
    if (cursor < comments.length && match.index >= comments[cursor][0] && match.index < comments[cursor][1]) {
      continue;
    }
    sites.push({ value: match[0].slice(1), start: match.index, marker: match[0][0] });
  }
  return sites;
}

/* Finds the `>` that closes a tag, ignoring quotes and `{...}` expression
 * containers. JSX attribute values routinely contain both.
 */
function findTagEnd(text, start) {
  let index = start;
  let depth = 0;
  let quote = "";
  const limit = Math.min(text.length, start + MAX_TAG_LENGTH);

  while (index < limit) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = "";
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) depth -= 1;
      index += 1;
      continue;
    }
    if (char === ">" && depth === 0) return index;
    index += 1;
  }

  return -1;
}

export function parseAttributes(inner, offset) {
  const attributes = [];
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(inner))) {
    const raw = match[2];
    const valueStart = offset + match.index + match[0].length - raw.length;
    let value = raw;
    if (raw.startsWith("\"") || raw.startsWith("'")) {
      value = decodeEscapes(raw.slice(1, -1));
    } else if (raw.startsWith("{")) {
      const inner2 = raw.slice(1, -1).trim();
      if (
        (inner2.startsWith("\"") && inner2.endsWith("\"")) ||
        (inner2.startsWith("'") && inner2.endsWith("'")) ||
        (inner2.startsWith("`") && inner2.endsWith("`"))
      ) {
        value = decodeEscapes(inner2.slice(1, -1));
      } else {
        value = "";
      }
    }
    attributes.push({
      name: match[1],
      value,
      raw,
      start: offset + match.index,
      valueStart,
      expression: raw.startsWith("{"),
    });
  }
  return attributes;
}

/* Every tag in raw text, opening and closing, in source order. Works for JSX,
 * Vue templates, Svelte, Astro, and plain HTML, because all of them are the
 * same `<tag attr>` shape.
 *
 * Closing tags are included deliberately. Without them the gap between two
 * opening tags spans the previous element's children *and* its closing tag,
 * so text-run extraction would report `"$9</span> </article>"` as one node's
 * text. Consumers that only care about elements filter on `closing`.
 *
 * Callers must only use this on extensions that carry markup (`jsx`, `tsx`,
 * `vue`, `svelte`, `astro`, `html`). A `.ts` file legitimately contains
 * `a <b ? 1 : 2`, which is lexically indistinguishable from a `<b>` element;
 * a `.tsx` file cannot, because that would be a syntax error there. The
 * preceding-character guard below catches `a < b` but cannot catch every
 * comparison, so the extension check is what actually makes this safe.
 */
export function scanTagRegions(text, comments = []) {
  const regions = [];
  let index = 0;

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt === -1) break;
    index = lt + 1;

    if (inRanges(comments, lt)) continue;

    const after = text[lt + 1];
    if (!after || after === "!" || after === "?") continue;

    /* Closing tags are checked before the preceding-character guard. That
     * guard exists to reject `a < b` comparisons, and `</` can never be a
     * comparison, so applying it here would drop `$9</span>` — the `9` before
     * `<` is not a character that may precede a tag.
     */
    if (after === "/") {
      const closeMatch = TAG_NAME_PATTERN.exec(text.slice(lt + 2, lt + 2 + 120));
      if (!closeMatch) continue;
      const closeTag = closeMatch[0];
      const closeEnd = text.indexOf(">", lt + 2 + closeTag.length);
      if (closeEnd === -1) continue;
      regions.push({
        tag: closeTag,
        start: lt,
        end: closeEnd + 1,
        nameEnd: lt + 2 + closeTag.length,
        inner: "",
        attributes: [],
        selfClosing: false,
        closing: true,
      });
      index = closeEnd + 1;
      continue;
    }

    const previous = lt === 0 ? "" : text[lt - 1];
    if (previous !== "" && !TAG_MAY_FOLLOW.test(previous)) continue;

    const nameMatch = TAG_NAME_PATTERN.exec(text.slice(lt + 1, lt + 1 + 120));
    if (!nameMatch) continue;
    const tag = nameMatch[0];
    const nameEnd = lt + 1 + tag.length;

    const nextChar = text[nameEnd];
    if (nextChar !== undefined && !/[\s/>]/.test(nextChar)) continue;

    const end = findTagEnd(text, nameEnd);
    if (end === -1) continue;

    const inner = text.slice(nameEnd, end);
    regions.push({
      tag,
      start: lt,
      end: end + 1,
      nameEnd,
      inner,
      attributes: parseAttributes(inner, nameEnd),
      selfClosing: inner.trimEnd().endsWith("/"),
      closing: false,
    });

    index = end + 1;
  }

  return regions;
}

/* Text nodes sitting between tag regions. Returned separately from the regions
 * so callers can attribute them to an element using whatever structure they
 * have, without this module needing to model nesting.
 */
export function scanTextRuns(text, regions, comments = []) {
  const runs = [];
  for (let index = 0; index < regions.length; index += 1) {
    const from = regions[index].end;
    const to = index + 1 < regions.length ? regions[index + 1].start : text.length;
    if (to <= from) continue;
    const value = text.slice(from, to).replace(/\s+/g, " ").trim();
    if (value.length === 0) continue;
    if (value.startsWith("{")) continue;
    if (inRanges(comments, from)) continue;
    runs.push({ value, start: from, end: to, afterRegion: index });
  }
  return runs;
}

function findBlockEnd(text, tag, from) {
  const open = new RegExp(`<${tag}\\b`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let index = from;

  while (index < text.length) {
    open.lastIndex = index;
    close.lastIndex = index;
    const nextOpen = open.exec(text);
    const nextClose = close.exec(text);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      index = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose.index;
    index = nextClose.index + nextClose[0].length;
  }

  return -1;
}

/* Splits a Vue single-file component into its top-level blocks.
 *
 * `depth` counting matters: a template with `<template v-if>` inside it has
 * two closing tags, and a lazy regex would stop at the inner one and hand the
 * parser a truncated template.
 */
export function splitVueSfc(text) {
  const blocks = [];
  const pattern = /<(script|template|style)\b([^>]*)>/gi;
  let match;

  while ((match = pattern.exec(text))) {
    const tag = match[1].toLowerCase();
    const contentStart = match.index + match[0].length;
    const closeIndex = findBlockEnd(text, tag, contentStart);
    const contentEnd = closeIndex === -1 ? text.length : closeIndex;
    blocks.push({
      tag,
      attrs: match[2],
      start: match.index,
      contentStart,
      contentEnd,
      content: text.slice(contentStart, contentEnd),
      lang: (/lang\s*=\s*["']?([A-Za-z0-9]+)/i.exec(match[2]) || [])[1] || "",
    });
    pattern.lastIndex = closeIndex === -1 ? text.length : closeIndex;
  }

  return blocks;
}
