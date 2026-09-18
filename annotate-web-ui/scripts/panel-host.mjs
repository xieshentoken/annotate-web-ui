// Loopback host for the floating panel.
//
// The floating window (and any browser tab pointed at the same URL) is a second
// view of one annotate session. It is not injected into the page and it shares
// no JavaScript with it: this module serves the panel page over loopback,
// streams the page's state to it as server-sent events, and forwards the panel's
// commands back over the CDP connection the session already owns.
//
// Two properties are deliberate:
//
//   * The injected page still makes no network requests. Everything that
//     crosses this boundary is either a CDP call or a message on the binding the
//     session already installed.
//   * The relay is unreachable from a web page. It binds 127.0.0.1 only, every
//     route needs the session token, and no CORS header is ever sent, so a page
//     that guessed the port still could not read a response or post JSON.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PATH = path.resolve(SCRIPT_DIR, "../assets/floating-panel.html");

// Fast enough that a change made in-page (a drag, a hotkey) shows up in the
// floating window while the hand is still moving; the poll only runs while a
// panel is actually connected.
const POLL_INTERVAL_MS = 250;

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export async function startPanelHost({ client, token = randomBytes(16).toString("hex"), onHello = null }) {
  const clients = new Set();
  let snapshot = null;
  let helloCount = 0;
  let closed = false;

  const broadcast = (message) => {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const response of clients) {
      try {
        response.write(payload);
      } catch {
        clients.delete(response);
      }
    }
  };

  // The snapshot is read as a JSON string so the page's own serializer decides
  // what crosses the boundary, and an unchanged snapshot is not re-sent.
  const readState = async () => {
    const result = await client.send("Runtime.evaluate", {
      expression:
        "window.__SYMBUI_PANEL_STATE__ ? JSON.stringify(window.__SYMBUI_PANEL_STATE__()) : null",
      returnByValue: true,
    });
    return result?.result?.value || null;
  };

  const poll = async () => {
    if (closed || clients.size === 0) return;
    try {
      const next = await readState();
      if (!next || next === snapshot) return;
      snapshot = next;
      broadcast({ type: "state", state: JSON.parse(next) });
    } catch {
      // The page may be navigating or reloading right now; the next tick tries
      // again rather than tearing the stream down.
    }
  };

  const runCommand = async (command) => {
    const expression =
      "window.__SYMBUI_PANEL_COMMAND__ ? " +
      `JSON.stringify(window.__SYMBUI_PANEL_COMMAND__(${JSON.stringify(command)})) : ` +
      'JSON.stringify({ok:false,error:"页面还没有装上标注面板"})';
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!value) return { ok: false, error: "页面没有响应这条指令" };
    try {
      return JSON.parse(value);
    } catch {
      return { ok: false, error: "页面返回了无法解析的指令结果" };
    }
  };

  const server = createServer(async (request, response) => {
    const reply = (status, body, headers = {}) => {
      response.writeHead(status, {
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      reply(400, "bad request");
      return;
    }

    // Browsers ask for a favicon without the token; answering instead of
    // refusing keeps the console clean, and it reveals nothing.
    if (url.pathname === "/favicon.ico") {
      reply(204, "");
      return;
    }

    if (url.searchParams.get("token") !== token) {
      reply(403, "forbidden");
      return;
    }

    if (url.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      if (snapshot) broadcast({ type: "state", state: JSON.parse(snapshot) });
      request.on("close", () => clients.delete(response));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/panel.html") {
      const html = await readFile(PANEL_PATH, "utf8").catch(() => null);
      if (html == null) {
        reply(500, "the floating panel page is missing");
        return;
      }
      reply(200, html, { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/hello" && request.method === "POST") {
      helloCount += 1;
      if (typeof onHello === "function") {
        try {
          onHello(helloCount);
        } catch {
          // A broken observer must not break the panel.
        }
      }
      reply(204, "");
      return;
    }

    if (url.pathname === "/command" && request.method === "POST") {
      let command;
      try {
        command = JSON.parse(await readBody(request));
      } catch {
        reply(400, JSON.stringify({ ok: false, error: "指令不是合法的 JSON" }), {
          "content-type": "application/json; charset=utf-8",
        });
        return;
      }
      let result;
      try {
        result = await runCommand(command);
      } catch (error) {
        result = { ok: false, error: error?.message || String(error) };
      }
      reply(200, JSON.stringify(result), {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    reply(404, "not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const timer = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/panel.html?token=${token}`,
    push(message) {
      broadcast(message);
    },
    clientCount() {
      return clients.size;
    },
    helloCount() {
      return helloCount;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const response of clients) {
        try {
          response.end();
        } catch {
          // Already gone.
        }
      }
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
