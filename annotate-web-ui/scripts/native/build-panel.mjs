#!/usr/bin/env node

// Compile scripts/native/panel.swift into scripts/native/.build/symbui-panel.
//
//     node annotate-web-ui/scripts/native/build-panel.mjs [--force]
//
// The binary's absolute path is the last line of stdout, with or without a
// rebuild, so a caller can always read the path from the last line. Progress and
// the exact swiftc invocation go to stderr. Nothing is downloaded and
// `xcode-select --install` is never run: if swiftc is missing this exits
// non-zero and says so.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SOURCE = path.join(HERE, "panel.swift");
const BUILD_DIR = path.join(HERE, ".build");
const BINARY = path.join(BUILD_DIR, "symbui-panel");
const GITIGNORE = path.join(ROOT, ".gitignore");
const IGNORE_LINE = "annotate-web-ui/scripts/native/.build/";

function upToDate() {
  try {
    return statSync(BINARY).mtimeMs >= statSync(SOURCE).mtimeMs;
  } catch {
    return false;
  }
}

// Adds the build directory to an existing .gitignore. A repository without one
// gets none: creating ignore files is the author's call, not this script's.
function ignoreBuildDir() {
  if (!existsSync(GITIGNORE)) return "no .gitignore";
  const text = readFileSync(GITIGNORE, "utf8");
  const entries = text.split("\n").map((line) => line.trim());
  if (entries.includes(IGNORE_LINE) || entries.includes(IGNORE_LINE.replace(/\/$/, ""))) {
    return "already ignored";
  }
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  writeFileSync(GITIGNORE, `${base}${IGNORE_LINE}\n`);
  return "added";
}

function compile() {
  const probe = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      [
        "build-panel: swiftc is not available on PATH, so panel.swift cannot be built.",
        "build-panel: install the Xcode Command Line Tools (xcode-select --install) and rerun.",
        probe.error ? `build-panel: ${probe.error.message}` : "",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(1);
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const args = [
    "-O",
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "-o",
    BINARY,
    SOURCE,
  ];
  process.stderr.write(`build-panel: swiftc ${args.join(" ")}\n`);
  const result = spawnSync("swiftc", args, { encoding: "utf8" });
  if (result.error) {
    process.stderr.write(`build-panel: swiftc failed to start: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.stdout.trim() !== "") process.stderr.write(result.stdout);
  if (result.stderr.trim() !== "") process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stderr.write(`build-panel: swiftc exited with ${result.status}\n`);
    process.exit(1);
  }
  if (!existsSync(BINARY)) {
    process.stderr.write(`build-panel: swiftc reported success but ${BINARY} is missing\n`);
    process.exit(1);
  }
  chmodSync(BINARY, 0o755);
}

function main(argv) {
  if (!existsSync(SOURCE)) {
    process.stderr.write(`build-panel: ${SOURCE} is missing\n`);
    process.exit(1);
  }
  const force = argv.includes("--force");
  if (force || !upToDate()) {
    compile();
  } else {
    process.stderr.write(`build-panel: ${BINARY} is newer than panel.swift, skipping compile\n`);
  }
  process.stderr.write(`build-panel: .gitignore ${ignoreBuildDir()}\n`);
  process.stdout.write(`${BINARY}\n`);
}

main(process.argv.slice(2));
