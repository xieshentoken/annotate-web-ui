import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".map", "application/json; charset=utf-8"],
]);

const BLOCKED_SEGMENTS = new Set([".git", ".hg", ".svn", ".symbui"]);

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

function hasBlockedSegment(relativePath) {
  return relativePath.split(/[\\/]/).some((segment) => {
    const lower = segment.toLowerCase();
    return (
      BLOCKED_SEGMENTS.has(lower) ||
      lower === ".env" ||
      lower.startsWith(".env.")
    );
  });
}

async function resolveEntryFile(directoryPath) {
  for (const name of ["index.html", "index.htm"]) {
    const candidate = path.join(directoryPath, name);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return name;
    } catch {
      // Try the next conventional static entry file.
    }
  }
  throw new Error(
    "--static directory must contain index.html or index.htm, or point directly to an HTML file.",
  );
}

export async function resolveStaticSite({ repoPath, staticPath = true }) {
  const resolvedRepo = await realpath(repoPath);
  const requested = staticPath === true ? resolvedRepo : staticPath;
  if (typeof requested !== "string" || !path.isAbsolute(requested)) {
    throw new Error("--static must be an absolute directory or HTML file path.");
  }

  let resolvedTarget;
  try {
    resolvedTarget = await realpath(requested);
  } catch {
    throw new Error("--static path does not exist: " + requested);
  }
  if (!isInside(resolvedRepo, resolvedTarget)) {
    throw new Error("--static path must stay inside the selected repository.");
  }
  if (hasBlockedSegment(path.relative(resolvedRepo, resolvedTarget))) {
    throw new Error("--static path cannot point into private project metadata.");
  }

  const info = await stat(resolvedTarget);
  let rootPath;
  let entryFile;
  if (info.isDirectory()) {
    rootPath = resolvedTarget;
    entryFile = await resolveEntryFile(rootPath);
  } else if (info.isFile()) {
    if (![".html", ".htm"].includes(path.extname(resolvedTarget).toLowerCase())) {
      throw new Error("--static file must be an HTML or HTM document.");
    }
    rootPath = path.dirname(resolvedTarget);
    entryFile = path.basename(resolvedTarget);
  } else {
    throw new Error("--static must point to a directory or regular HTML file.");
  }

  const entryPath = await realpath(path.join(rootPath, entryFile));
  if (!isInside(rootPath, entryPath) || !isInside(resolvedRepo, entryPath)) {
    throw new Error("Static entry file resolves outside the selected repository.");
  }

  return {
    repoPath: resolvedRepo,
    rootPath,
    entryFile,
    entryPath,
  };
}

function sendText(response, statusCode, message) {
  const body = Buffer.from(message + "\n", "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function resolveRequestFile(site, rawUrl) {
  let decoded;
  try {
    const parsed = new URL(rawUrl || "/", "http://127.0.0.1");
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return { statusCode: 400 };
  }
  if (decoded.includes("\0")) return { statusCode: 400 };

  let relativePath = decoded.replace(/^[/\\]+/, "");
  if (relativePath === "") relativePath = site.entryFile;
  if (hasBlockedSegment(relativePath)) return { statusCode: 403 };

  let candidate = path.resolve(site.rootPath, relativePath);
  if (!isInside(site.rootPath, candidate)) return { statusCode: 403 };

  try {
    let info = await stat(candidate);
    if (info.isDirectory()) {
      candidate = path.join(candidate, "index.html");
      info = await stat(candidate);
    }
    if (!info.isFile()) return { statusCode: 404 };

    const resolved = await realpath(candidate);
    if (!isInside(site.rootPath, resolved)) return { statusCode: 403 };
    return {
      statusCode: 200,
      filePath: resolved,
      size: info.size,
      contentType:
        MIME_TYPES.get(path.extname(resolved).toLowerCase()) ||
        "application/octet-stream",
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      return { statusCode: 404 };
    }
    if (["EACCES", "EPERM"].includes(error?.code)) {
      return { statusCode: 403 };
    }
    throw error;
  }
}

export async function startStaticSite(site) {
  const server = createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method not allowed");
      return;
    }

    try {
      const result = await resolveRequestFile(site, request.url);
      if (result.statusCode !== 200) {
        const messages = {
          400: "Bad request",
          403: "Forbidden",
          404: "Not found",
        };
        sendText(
          response,
          result.statusCode,
          messages[result.statusCode] || "Request failed",
        );
        return;
      }

      response.writeHead(200, {
        "Content-Type": result.contentType,
        "Content-Length": result.size,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(result.filePath);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent) sendText(response, 500, "Internal server error");
      else response.destroy();
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Static server did not expose a loopback TCP address.");
  }

  let closed = false;
  return {
    ...site,
    url: "http://127.0.0.1:" + address.port + "/",
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
  };
}
