#!/usr/bin/env node

// Serve a review directory on loopback until interrupted.
//
// review-session.mjs --serve is the normal path: it serves the preview and
// stops as soon as the reviewer saves. This script is for reopening a round
// that was already reviewed, or for keeping the preview up while you look
// around. It binds 127.0.0.1 only, and the POST endpoint writes the reviewer's
// decisions to the round's own review-annotations.json.

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeJson } from "./lib/session.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

export function serveReviewDir(root, { port = 0, onSave = null } = {}) {
  const absolute = path.resolve(root);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "POST" && url.pathname === "/save") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (onSave) await onSave(payload);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true }));
          } catch (error) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
        return;
      }

      let relative = decodeURIComponent(url.pathname);
      if (relative === "/" || relative === "") relative = "/review.html";
      const target = path.join(absolute, relative);
      if (!target.startsWith(absolute)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      try {
        const body = await readFile(target);
        response.writeHead(200, {
          "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("not found");
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}/review.html`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    throw new Error("Usage: serve-review.mjs --dir <review-directory> [--port 0]");
  }
  const savePath = path.join(path.resolve(args.dir), "..", "review-annotations.json");
  const running = await serveReviewDir(args.dir, {
    port: args.port ? Number(args.port) : 0,
    onSave: (payload) => writeJson(savePath, payload),
  });
  console.log(`SYMBUI_REVIEW_URL=${running.url}`);
  console.log(`复审结果将写入 ${savePath}`);
  console.log("按 Ctrl-C 停止。");
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
