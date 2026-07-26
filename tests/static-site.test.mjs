import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStaticSite,
  startStaticSite,
} from "../annotate-web-ui/scripts/static-site.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.dirname(TEST_DIR);
const FIXTURE_PATH = path.join(TEST_DIR, "fixture");

function rawStatus(url, requestPath) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: requestPath,
        method: "GET",
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("resolves a static directory and direct HTML entry", async () => {
  const directory = await resolveStaticSite({
    repoPath: REPO_PATH,
    staticPath: FIXTURE_PATH,
  });
  assert.equal(directory.entryFile, "index.html");

  const directFile = await resolveStaticSite({
    repoPath: REPO_PATH,
    staticPath: path.join(FIXTURE_PATH, "index.html"),
  });
  assert.equal(directFile.rootPath, directory.rootPath);
  assert.equal(directFile.entryPath, directory.entryPath);
});

test("rejects static targets outside the repository", async () => {
  await assert.rejects(
    resolveStaticSite({
      repoPath: REPO_PATH,
      staticPath: path.dirname(REPO_PATH),
    }),
    /must stay inside/,
  );
});

test("serves HTML, CSS, and JavaScript on loopback and blocks traversal", async (t) => {
  const site = await resolveStaticSite({
    repoPath: REPO_PATH,
    staticPath: FIXTURE_PATH,
  });
  const runtime = await startStaticSite(site);
  t.after(() => runtime.close());

  const html = await fetch(runtime.url);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.match(await html.text(), /SymbUI 本地测试页/);

  const css = await fetch(new URL("fixture.css", runtime.url));
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/);
  assert.match(await css.text(), /symbui-static-asset/);

  const script = await fetch(new URL("fixture.js", runtime.url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(await script.text(), /staticFixture/);

  assert.equal(
    await rawStatus(runtime.url, "/%2e%2e%2fAGENTS.md"),
    403,
  );
});
