// Minimal Chrome DevTools Protocol client.
//
// Node 22 ships a global WebSocket, so this needs no dependency. It speaks only
// the handful of domains the capture path uses.

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
        try { socket.close(); } catch { /* ignore */ }
      }, timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(this);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${this.url}`));
      });
      socket.addEventListener("close", () => {
        this.closed = true;
        for (const { reject: fail } of this.pending.values()) {
          fail(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve: done, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) fail(new Error(`${message.error.message || "CDP error"}`));
          else done(message.result);
          return;
        }
        if (message.method) {
          const list = this.handlers.get(message.method);
          if (!list) return;
          for (const handler of list) {
            try { handler(message.params, message.sessionId); } catch { /* ignore */ }
          }
        }
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.socket || this.closed) {
      return Promise.reject(new Error(`CDP send on a closed connection: ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
    return this;
  }

  close() {
    this.closed = true;
    try { this.socket?.close(); } catch { /* ignore */ }
  }
}

export async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForVersion(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`DevTools endpoint on port ${port} never became ready: ${lastError?.message}`);
}

// Pick the page target that belongs to the session, not an extension or a
// background page.
export async function findPageTarget(port, targetUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const wanted = targetUrl ? new URL(targetUrl) : null;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    const pages = targets.filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl,
    );
    if (pages.length > 0) {
      if (!wanted) return pages[0];
      const exact = pages.find((page) => {
        try { return new URL(page.url).origin === wanted.origin; } catch { return false; }
      });
      return exact || pages[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No page target on port ${port}`);
}

export async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "evaluation failed";
    throw new Error(description);
  }
  return result.result?.value;
}
