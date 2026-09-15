/* SymbUI inventory probe.
 *
 * Runs inside the target page and returns a deterministic inventory of the
 * rendered elements. The inventory is the alignment substrate for the revision
 * diff and the geometry source for direct-manipulation editing in review.html.
 *
 * The probe never mutates the page and never reads form values, storage, or
 * cookies.
 */
(function () {
  "use strict";

  // Size is not tracked here: `rect` already carries it, and duplicating it
  // makes every element inside a resized container look restyled as well.
  var STYLE_KEYS = [
    "display",
    "flexDirection",
    "justifyContent",
    "alignItems",
    "gap",
    "padding",
    "margin",
    "borderRadius",
    "border",
    "backgroundColor",
    "color",
    "boxShadow",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "opacity",
  ];

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, HEAD: 1, TITLE: 1, NOSCRIPT: 1,
    TEMPLATE: 1, BR: 1, WBR: 1, SOURCE: 1, TRACK: 1, PARAM: 1, BASE: 1,
  };

  var MAX_ELEMENTS = 4000;

  function text(value, limit) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit || 120);
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  /* --------------------------------------------------------- source anchor */

  function fiberSource(element) {
    var names = Object.getOwnPropertyNames(element);
    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      if (name.indexOf("__reactFiber$") !== 0 && name.indexOf("__reactInternalInstance$") !== 0) {
        continue;
      }
      var fiber = element[name];
      var depth = 0;
      while (fiber && depth < 40) {
        var source = fiber._debugSource || (fiber._debugInfo && fiber._debugInfo[0] && fiber._debugInfo[0].source);
        var type = fiber.type;
        var component =
          typeof type === "function" ? type.displayName || type.name || "" :
          type && typeof type === "object" ? type.displayName || type.name || "" : "";
        if (source && source.fileName) {
          return {
            file: String(source.fileName),
            line: Number(source.lineNumber) || 1,
            column: Number(source.columnNumber) || null,
            component: component,
          };
        }
        if (component && !source) {
          fiber = fiber.return;
          depth += 1;
          continue;
        }
        fiber = fiber.return;
        depth += 1;
      }
    }
    return null;
  }

  function vueSource(element) {
    var instance = element.__vueParentComponent;
    if (!instance) return null;
    var depth = 0;
    while (instance && depth < 40) {
      var type = instance.type;
      var file = type && (type.__file || type.__fileName);
      if (file) {
        return {
          file: String(file),
          line: 1,
          column: null,
          component: (type.name || type.__name || "") + "",
        };
      }
      instance = instance.parent;
      depth += 1;
    }
    return null;
  }

  function svelteSource(element) {
    var meta = element.__svelte_meta;
    if (!meta) return null;
    var loc = meta.loc || {};
    if (!loc.file) return null;
    return {
      file: String(loc.file),
      line: Number(loc.line) || 1,
      column: Number(loc.column) || null,
      component: "",
    };
  }

  function attributeSource(element) {
    var raw =
      element.getAttribute("data-ui-source") ||
      element.getAttribute("data-source-file") ||
      "";
    if (!raw) return null;
    var lineAttribute =
      element.getAttribute("data-source-line") ||
      element.getAttribute("data-ui-source-line") ||
      "";
    var file = raw;
    var line = Number(lineAttribute) || 1;
    var column = null;
    var match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (match) {
      file = match[1];
      line = Number(match[2]);
      column = match[3] ? Number(match[3]) : null;
    }
    return {
      file: file,
      line: line,
      column: column,
      component:
        element.getAttribute("data-component") ||
        element.getAttribute("data-component-name") ||
        "",
    };
  }

  function normalizeAnchor(anchor) {
    if (!anchor || !anchor.file) return null;
    var file = String(anchor.file);
    // Dev servers usually serve absolute or origin-relative paths. Reduce to a
    // repository-relative-looking path so it can be matched against source.
    file = file.replace(/^https?:\/\/[^/]+/, "");
    file = file.replace(/^webpack:\/\/[^/]*\//, "");
    file = file.replace(/^vite:\/\/[^/]*\//, "");
    file = file.replace(/^file:\/\//, "");
    file = file.replace(/^\/@fs\//, "/");
    file = file.replace(/^\/*/, "");
    file = file.split("?")[0].split("#")[0];
    if (!file) return null;
    return {
      file: file,
      line: Number(anchor.line) || 1,
      column: anchor.column == null ? null : Number(anchor.column),
      component: text(anchor.component, 80),
    };
  }

  function sourceFor(element) {
    try {
      return (
        normalizeAnchor(attributeSource(element)) ||
        normalizeAnchor(fiberSource(element)) ||
        normalizeAnchor(vueSource(element)) ||
        normalizeAnchor(svelteSource(element))
      );
    } catch (error) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- selectors */

  function stableSelector(element) {
    var testId =
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test") ||
      element.getAttribute("data-cy");
    if (testId) {
      var attribute = element.hasAttribute("data-testid")
        ? "data-testid"
        : element.hasAttribute("data-test")
          ? "data-test"
          : "data-cy";
      return "[" + attribute + '="' + cssEscape(testId) + '"]';
    }
    if (element.id) return "#" + cssEscape(element.id);
    var parts = [];
    var node = element;
    for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      var part = node.tagName.toLowerCase();
      var role = node.getAttribute("role");
      if (role) part += '[role="' + cssEscape(role) + '"]';
      var parent = node.parentElement;
      if (parent) {
        var siblings = [];
        for (var index = 0; index < parent.children.length; index += 1) {
          if (parent.children[index].tagName === node.tagName) siblings.push(parent.children[index]);
        }
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (node === document.body) break;
      node = parent;
    }
    return parts.join(" > ");
  }

  function inferredRole(element) {
    var explicit = element.getAttribute("role");
    if (explicit) return explicit;
    var tag = element.tagName.toLowerCase();
    var map = {
      a: element.hasAttribute("href") ? "link" : null,
      button: "button", input: "textbox", select: "combobox", textarea: "textbox",
      img: "img", nav: "navigation", main: "main", header: "banner",
      footer: "contentinfo", aside: "complementary", form: "form",
      h1: "heading", h2: "heading", h3: "heading", h4: "heading",
      h5: "heading", h6: "heading", ul: "list", ol: "list", li: "listitem",
      table: "table", dialog: "dialog",
    };
    if (tag === "input") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
    }
    return map[tag] || null;
  }

  function accessibleName(element) {
    var label = element.getAttribute("aria-label");
    if (label) return text(label, 120);
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var target = document.getElementById(labelledBy);
      if (target) return text(target.textContent, 120);
    }
    var alt = element.getAttribute("alt");
    if (alt) return text(alt, 120);
    var title = element.getAttribute("title");
    if (title) return text(title, 120);
    var type = (element.getAttribute("type") || "").toLowerCase();
    if (type === "password") return "[password field]";
    var value = element.getAttribute("value");
    if (value && (element.tagName === "INPUT" || element.tagName === "BUTTON")) {
      return text(value, 120);
    }
    return text(element.innerText || element.textContent || "", 120);
  }

  /* ------------------------------------------------------------------ styles */

  function styleFor(computed) {
    var result = {};
    for (var index = 0; index < STYLE_KEYS.length; index += 1) {
      var key = STYLE_KEYS[index];
      var value = computed[key];
      if (value == null || value === "") continue;
      if (key === "width" || key === "height") {
        if (value === "auto" || value === "0px") continue;
      }
      result[key] = String(value);
    }
    return result;
  }

  /* ------------------------------------------------------------------- main */

  // The element's own identity, independent of where it sits in the tree.
  // A list renders one anchor many times, so when the element carries a test id
  // as well, that id is what tells two rows apart.
  function localKeyFor(anchor, testId, id, role, name, selector, geometry) {
    if (anchor && anchor.file) {
      var base = anchor.file + ":" + anchor.line + "#" + (anchor.component || "");
      return testId ? base + "[" + testId + "]" : base;
    }
    if (testId) return "testid:" + testId;
    if (id) return "id:" + id;
    if (role && name) return "role:" + role + "|" + name;
    if (selector) return "sel:" + selector;
    return (
      "geo:" + Math.round(geometry.x) + "," + Math.round(geometry.y) +
      "," + Math.round(geometry.width) + "," + Math.round(geometry.height)
    );
  }

  function collect(options) {
    var settings = options || {};
    var limit = Number(settings.maxElements) || MAX_ELEMENTS;
    var host =
      document.querySelector("#__symbui-host") ||
      document.querySelector("[data-symbui-host]") ||
      null;
    var nodes = document.body ? document.body.querySelectorAll("*") : [];
    var elements = [];
    var recordByNode = new Map();
    var nodeByRecord = new Map();
    var index;

    for (index = 0; index < nodes.length && elements.length < limit; index += 1) {
      var element = nodes[index];
      if (SKIP_TAGS[element.tagName]) continue;
      if (host && (element === host || host.contains(element))) continue;
      if (element.hasAttribute("data-symbui-skip")) continue;

      var rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      var computed = window.getComputedStyle(element);
      if (computed.display === "none" || computed.visibility === "hidden") continue;
      if (Number(computed.opacity) === 0) continue;

      var anchor = sourceFor(element);
      var testId =
        element.getAttribute("data-testid") ||
        element.getAttribute("data-test") ||
        element.getAttribute("data-cy") ||
        "";
      var role = inferredRole(element) || "";
      var name = accessibleName(element);
      var selector = stableSelector(element);
      var geometry = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };

      var record = {
        localKey: localKeyFor(anchor, testId, element.id || "", role, name, selector, geometry),
        anchor: anchor,
        selector: selector,
        testId: testId,
        id: element.id || "",
        role: role,
        name: name,
        tag: element.tagName.toLowerCase(),
        text: text(element.innerText || element.textContent || "", 80),
        rect: geometry,
        style: styleFor(computed),
        tokens: {},
        reuseCount: 1,
        visible: true,
        // A key built only from structure can shift when the page reflows.
        unstable: !anchor && !testId && !element.id,
      };
      if (settings.includeAncestry) {
        var ancestry = [];
        var parent = element.parentElement;
        for (var depth = 0; parent && depth < 4; depth += 1) {
          ancestry.push({
            tag: parent.tagName.toLowerCase(),
            id: parent.id || "",
            className: text(typeof parent.className === "string" ? parent.className : "", 100),
          });
          parent = parent.parentElement;
        }
        record.ancestry = ancestry;
      }
      elements.push(record);
      recordByNode.set(element, record);
      nodeByRecord.set(record, element);
    }

    // The nearest captured ancestor. Two things need it: the key of an element
    // that has no identity of its own, and the diff's ability to tell a change
    // that was asked for apart from one that merely followed from it.
    for (index = 0; index < elements.length; index += 1) {
      var start = nodeByRecord.get(elements[index]);
      var parentNode = start ? start.parentElement : null;
      var hops = 0;
      while (parentNode && hops < 40) {
        var parentRecord = recordByNode.get(parentNode);
        if (parentRecord) {
          elements[index].parent = parentRecord;
          break;
        }
        parentNode = parentNode.parentElement;
        hops += 1;
      }
    }

    // Assign final keys in document order, so a parent is always named before
    // its children. An element with its own identity stands alone; anything
    // else is scoped by its parent's key. That is what keeps a list item's
    // children aligned when a sibling item is inserted or removed.
    var composed = {};
    for (index = 0; index < elements.length; index += 1) {
      var item = elements[index];
      var scoped = item.testId || item.id
        ? item.localKey
        : item.parent
          ? item.parent.key + " > " + item.localKey
          : item.localKey;
      var seen = composed[scoped] || 0;
      composed[scoped] = seen + 1;
      item.key = seen === 0 ? scoped : scoped + "@" + (seen + 1);
      if (item.parent) item.parentKey = item.parent.key;
      delete item.localKey;
      delete item.parent;
    }

    var counts = {};
    for (index = 0; index < elements.length; index += 1) {
      var key = elements[index].key;
      counts[key] = (counts[key] || 0) + 1;
    }
    for (index = 0; index < elements.length; index += 1) {
      elements[index].reuseCount = counts[elements[index].key];
    }

    var anchored = 0;
    var unstable = 0;
    for (index = 0; index < elements.length; index += 1) {
      if (elements[index].anchor) anchored += 1;
      if (elements[index].unstable) unstable += 1;
    }

    return {
      stateId: settings.stateId || null,
      url: location.href,
      capturedAt: new Date().toISOString(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1,
      },
      scroll: { x: window.scrollX, y: window.scrollY },
      stats: {
        elements: elements.length,
        anchored: anchored,
        unstable: unstable,
        truncated: elements.length >= limit,
      },
      elements: elements,
    };
  }

  window.__SYMBUI_INVENTORY__ = collect;
  window.__SYMBUI_INVENTORY_VERSION__ = "1.2";
})();
