import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pathExists, readJson } from "./session.mjs";

export const DEFAULT_CONFIG = {
  review: {
    model: {
      mode: "host-agent",
      provider: "openai",
      baseUrl: null,
      model: null,
      apiKeyEnv: "SYMBUI_MODEL_API_KEY",
      apiKeyFile: "~/.symbui/credentials.json",
      timeoutMs: 60000,
      maxOutputTokens: 4096,
    },
    maxRounds: 3,
    autoConsolidate: true,
    pixelTolerance: 1,
  },
};

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", style: "openai" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", style: "anthropic" },
  "openai-compatible": { baseUrl: null, style: "openai" },
};

export function expandHome(value) {
  if (typeof value !== "string" || !value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) result[key] = deepMerge(base[key], value);
    else if (value !== undefined) result[key] = value;
  }
  return result;
}

export async function configCandidates({ repoPath, configPath }) {
  const list = [];
  if (configPath) list.push(path.resolve(expandHome(configPath)));
  if (repoPath) list.push(path.join(repoPath, ".symbui", "config.json"));
  list.push(path.join(os.homedir(), ".symbui", "config.json"));
  return list;
}

export async function loadConfig({ repoPath = null, configPath = null } = {}) {
  const sources = [];
  let config = DEFAULT_CONFIG;
  for (const candidate of await configCandidates({ repoPath, configPath })) {
    if (!(await pathExists(candidate))) continue;
    const raw = await readJson(candidate);
    config = deepMerge(config, raw);
    sources.push(candidate);
  }
  const model = config.review.model;
  const provider = PROVIDER_DEFAULTS[model.provider] || PROVIDER_DEFAULTS["openai-compatible"];
  if (!model.baseUrl) model.baseUrl = provider.baseUrl;
  model.style = provider.style;
  return { config, sources, repoPath };
}

export function publicConfig(config) {
  const model = { ...config.review.model };
  delete model.style;
  delete model.apiKeyFile;
  return { review: { ...config.review, model } };
}

// The credential never leaves this function except as a return value. It is
// never logged, never merged into config, and never written to a session.
export async function resolveCredential(config, { repoPath = null } = {}) {
  const model = config.review.model;
  const envName = model.apiKeyEnv || "SYMBUI_MODEL_API_KEY";
  const checked = [];

  const fromEnv = process.env[envName];
  checked.push(`环境变量 ${envName}`);
  if (fromEnv && fromEnv.trim()) {
    return { apiKey: fromEnv.trim(), source: `环境变量 ${envName}` };
  }

  const file = expandHome(model.apiKeyFile || "~/.symbui/credentials.json");
  checked.push(`凭据文件 ${file}`);
  if (repoPath) {
    const relative = path.relative(path.resolve(repoPath), path.resolve(file));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new Error(
        `apiKeyFile 位于仓库内部（${file}）。把凭据放在仓库外，否则一次 git add 就会泄露密钥。`,
      );
    }
  }
  if (await pathExists(file)) {
    const info = await stat(file);
    const mode = info.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `凭据文件权限过于宽松（${mode.toString(8)}，应为 600）：${file}\n修正：chmod 600 "${file}"`,
      );
    }
    const raw = await readJson(file);
    const value = raw[envName] || raw.apiKey || raw.key;
    if (typeof value === "string" && value.trim()) {
      return { apiKey: value.trim(), source: `凭据文件 ${file}` };
    }
    throw new Error(`凭据文件里没有 ${envName} 字段：${file}`);
  }

  throw new Error(
    `byok 模式缺少 API key。已检查：${checked.join("；")}。\n` +
      `设置环境变量 export ${envName}=... ，或写入 ${file}（chmod 600）。\n` +
      `如果不想配置密钥，把 review.model.mode 设为 host-agent，由当前会话的 agent 完成判定。`,
  );
}

export function redact(text, secrets) {
  let output = String(text);
  for (const secret of secrets.filter(Boolean)) {
    if (secret.length < 8) continue;
    output = output.split(secret).join("[redacted]");
  }
  return output;
}
