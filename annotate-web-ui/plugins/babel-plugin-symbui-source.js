/* SymbUI anchor injection for JSX and TSX.
 *
 * A Babel plugin with no dependencies of its own: it uses the `types` object
 * Babel hands to every plugin rather than importing `@babel/types`. That keeps
 * it installable into any toolchain that already runs Babel, which is all of
 * them: Vite (via @vitejs/plugin-react), webpack + babel-loader, Next.js, CRA,
 * Rspack, Parcel, Metro, and any `babel.config.js` in between.
 *
 * The plugin is deliberately thin. It extracts a descriptor from the AST and
 * hands it to `planInjection` in ./anchor-core.js, which owns every rule about
 * whether to inject and what to write. Read that file first; the logic here is
 * only "where does the AST keep the facts".
 *
 *   babel.config.js
 *     plugins: [["/abs/path/to/plugins/babel-plugin-symbui-source.js", {
 *       root: __dirname,
 *     }]]
 *
 * Options:
 *   root            repository root used to relativize file paths.
 *                   Defaults to Babel's `cwd`.
 *   mode            force "development" or "production". Defaults to NODE_ENV.
 *   roots           extra candidate roots, tried after `root`.
 *   exclude         replacement list of excluded path segments.
 *   componentName   force the component name when the heuristic is wrong.
 *   emitComponent   set false to skip the data-component attribute.
 *   emitColumn      set false to always write "file:line".
 */

"use strict";

/* No `require` of node builtins here either. Vite bundles `vite.config.mjs`
 * with esbuild into an ES module, and a CommonJS `require("path")` anywhere in
 * this file's import graph becomes a shim that throws at config load time. The
 * Vite plugin imports this module statically, so that graph includes this file.
 * Path handling therefore comes from ./anchor-core.js, which is pure.
 */

var core = require("./anchor-core.js");

/* Vue and Svelte mark their own overlay scaffolding the same way the runtime
 * probe does, so a hand-written host element is respected too.
 */
var SKIP_ATTRIBUTES = ["data-symbui-skip", "data-symbui-host"];

var COMPONENT_STACK = "symbuiComponentStack";

/* ------------------------------------------------------------ name lookup */

/* JSX reports the component that *renders* an element, not the one it names.
 * Walking the function stack upward and taking the nearest named ancestor is
 * what makes `<li>` inside `items.map(...)` inside `ProductCard` report
 * "ProductCard" instead of nothing, and `<li>` inside a nested `Row` report
 * "Row".
 */
function nameOfFunction(path) {
  var node = path.node;
  if (!node) return "";

  if (node.id && typeof node.id.name === "string" && node.id.name) return node.id.name;

  /* A class method is not a component. `class Panel { render() { return <x/> } }`
   * must report "Panel", not "render" — so a method contributes no name of its
   * own and the enclosing class wins. Object methods are different: an object
   * literal of render helpers names its rows, and that name is useful.
   */
  if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") return "";

  if (node.key) {
    if (typeof node.key.name === "string" && node.key.name) return node.key.name;
    if (typeof node.key.value === "string" && node.key.value) return node.key.value;
  }

  var parent = path.parent;
  if (!parent) return "";

  /* `const Card = () => ...` */
  if (parent.type === "VariableDeclarator" && parent.id && typeof parent.id.name === "string") {
    return parent.id.name;
  }

  /* The HOC forms `memo(() => ...)`, `forwardRef((props, ref) => ...)`,
   * `observer(() => ...)`, and their TypeScript call wrappers.
   */
  if (parent.type === "CallExpression" && parent.arguments && parent.arguments.indexOf(node) >= 0) {
    var grandparent = path.parentPath && path.parentPath.parent;
    if (grandparent && grandparent.type === "VariableDeclarator" && grandparent.id) {
      if (typeof grandparent.id.name === "string" && grandparent.id.name) return grandparent.id.name;
    }
  }

  /* `exports.Card = function () {}` */
  if (parent.type === "AssignmentExpression" && parent.left && parent.left.property) {
    var property = parent.left.property;
    if (typeof property.name === "string" && property.name) return property.name;
    if (typeof property.value === "string" && property.value) return property.value;
  }

  return "";
}

/* Last resort: the file name is a good guess for a component module, and a
 * directory name is a better guess than nothing for `index.tsx`.
 */
function basenameComponent(filename) {
  if (!filename) return "";
  var base = core.pathBase(filename).replace(/\.(jsx|tsx|js|ts|mjs|cjs|vue|svelte)$/, "");
  if (!base || base === "index" || base === "main" || base === "App") {
    var parent = core.pathBase(core.pathDir(filename));
    if (parent && parent !== "." && parent !== "/") return parent;
  }
  return base;
}

/* ----------------------------------------------------------- jsx helpers */

function jsxName(node) {
  if (!node || !node.name) return "";
  if (node.name.type === "JSXIdentifier") return node.name.name;
  if (node.name.type === "JSXNamespacedName") {
    return node.name.namespace.name + ":" + node.name.name.name;
  }
  if (node.name.type === "JSXMemberExpression") {
    var parts = [];
    var cursor = node.name;
    while (cursor && cursor.type === "JSXMemberExpression") {
      parts.unshift(cursor.property.name);
      cursor = cursor.object;
    }
    if (cursor && cursor.type === "JSXIdentifier") parts.unshift(cursor.name);
    return parts.join(".");
  }
  return "";
}

function jsxAttributeNames(node) {
  var names = [];
  var attributes = (node && node.attributes) || [];
  for (var index = 0; index < attributes.length; index += 1) {
    var attribute = attributes[index];
    if (attribute.type === "JSXAttribute" && attribute.name && attribute.name.name) {
      names.push(attribute.name.name);
    }
  }
  return names;
}

/* The attribute is appended rather than prepended on purpose. JSX evaluates
 * attributes in source order, so a trailing attribute wins over any
 * `{...props}` spread the element may carry. Our value is ground truth and must
 * not be overridable by whatever the component happened to be passed.
 */
function makeAttribute(types, name, value) {
  return types.jsxAttribute(types.jsxIdentifier(name), types.stringLiteral(value));
}

/* --------------------------------------------------------------- plugin */

module.exports = function symbuiSourcePlugin(babel) {
  var types = babel.types;

  function stackOf(state) {
    return state[COMPONENT_STACK] || (state[COMPONENT_STACK] = []);
  }

  function nearestComponent(state) {
    var stack = stackOf(state);
    for (var index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]) return stack[index];
    }
    return "";
  }

  return {
    name: "symbui-source",

    visitor: {
      /* The stack only records names, and anonymous callbacks push an empty
       * entry so the nearest named ancestor still wins.
       */
      Function: {
        enter: function (functionPath, state) {
          stackOf(state).push(nameOfFunction(functionPath));
        },
        exit: function (functionPath, state) {
          stackOf(state).pop();
        },
      },

      Class: {
        enter: function (classPath, state) {
          stackOf(state).push(nameOfFunction(classPath));
        },
        exit: function (classPath, state) {
          stackOf(state).pop();
        },
      },

      JSXOpeningElement: function (jsxPath, state) {
        var options = state.opts || {};
        var file = state.file;
        var filename = file && file.opts ? file.opts.filename : "";
        if (!filename || filename === "unknown") return;

        var cwd = (file && file.opts && file.opts.cwd) || process.cwd();
        var absolute = core.isAbsolutePath(filename) ? filename : core.resolvePath(cwd, filename);

        var attributes = jsxAttributeNames(jsxPath.node);
        var skipRequested = false;
        for (var si = 0; si < SKIP_ATTRIBUTES.length; si += 1) {
          if (attributes.indexOf(SKIP_ATTRIBUTES[si]) >= 0) skipRequested = true;
        }

        var loc = jsxPath.node.loc && jsxPath.node.loc.start;

        var plan = core.planInjection(
          {
            tag: jsxName(jsxPath.node),
            file: absolute,
            line: loc ? loc.line : null,
            column: loc ? loc.column : null,
            component:
              nearestComponent(state) ||
              options.componentName ||
              basenameComponent(absolute),
            mode: options.mode,
            root: options.root ? core.resolvePath(cwd, options.root) : cwd,
            roots: options.roots,
            attributes: attributes,
            insideSymbuiHost: skipRequested,
          },
          options,
        );

        record(state, plan);

        if (!plan.inject) return;

        for (var index = 0; index < plan.attributes.length; index += 1) {
          var entry = plan.attributes[index];
          jsxPath.node.attributes.push(makeAttribute(types, entry.name, entry.value));
        }
      },
    },
  };
};

/* Stats land on `file.metadata.symbuiAnchors` so a bundler wrapper can report
 * real coverage instead of guessing. The alternative is a plugin that silently
 * does nothing and a user who cannot tell.
 */
function record(state, plan) {
  var file = state.file;
  if (!file) return;
  var metadata = file.metadata || (file.metadata = {});
  var stats = metadata.symbuiAnchors || (metadata.symbuiAnchors = { injected: 0, skipped: {} });
  if (plan.inject) {
    stats.injected += 1;
    return;
  }
  stats.skipped[plan.reason] = (stats.skipped[plan.reason] || 0) + 1;
}

module.exports.basenameComponent = basenameComponent;
module.exports.nameOfFunction = nameOfFunction;
module.exports.jsxName = jsxName;
