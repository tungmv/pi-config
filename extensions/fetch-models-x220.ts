/**
 * Fetch and register models from the custom x220 OpenAI-compatible proxy.
 *
 * The proxy catalog is loaded at startup and can be refreshed with `/fetch`.
 *
 * Configuration:
 *   MODELS_SERVER_URL  Proxy root (default: http://x220:8317)
 *   MODELS_API_KEY     Overrides the key stored in ~/.pi/agent/x220-api-key
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "x220";
const DEFAULT_SERVER_URL = "http://x220:8317";
const API_KEY_FILE = join(homedir(), ".pi", "agent", "x220-api-key");
const REQUEST_TIMEOUT_MS = 10_000;

function env(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  return key.endsWith("URL") ? value.replace(/\/+$/, "") : value;
}

function resolveApiKey(): string {
  const fromEnvironment = process.env.MODELS_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  try {
    const fromFile = readFileSync(API_KEY_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // A local key file is optional; the proxy may be configured without auth.
  }

  return "local";
}

interface ModelDefaults {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  compat?: ProviderModelConfig["compat"];
}

const DEFAULT_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens" as const,
};

// The proxy exposes router aliases as well as their upstream model IDs. Use
// the longest matching key so a specific model family wins over a generic one.
const KNOWN_DEFAULTS: Record<string, ModelDefaults> = {
  "smart-coding": {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  "deep-reasoning": {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text"],
  },
  "vision-balanced": {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: false,
    input: ["text", "image"],
  },
  "gpt-5.6": {
    contextWindow: 372_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
  },
  "gpt-5.5": {
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
  },
  "gpt-5.4": {
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
  },
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
  },
  "deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
  },
  "claude-opus": {
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    input: ["text", "image"],
  },
  "claude-sonnet": {
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    input: ["text", "image"],
  },
  claude: {
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text", "image"],
  },
  deepseek: {
    contextWindow: 128_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text"],
  },
  glm: {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  kimi: {
    contextWindow: 128_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text"],
  },
  gpt: {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  "*": {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: false,
    input: ["text"],
  },
};

interface CatalogModel {
  id: string;
  name?: string;
  context_window?: unknown;
  max_tokens?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
}

interface CatalogResponse {
  data?: unknown;
  models?: unknown;
}

type FetchResult =
  | { ok: true; models: ProviderModelConfig[] }
  | { ok: false; error: string };

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "number" && typeof value !== "string") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function resolveDefaults(id: string): ModelDefaults {
  const lower = id.toLowerCase();
  const matches = Object.entries(KNOWN_DEFAULTS)
    .filter(([key]) => key !== "*" && lower.includes(key))
    .sort(([left], [right]) => right.length - left.length);
  return matches[0]?.[1] ?? KNOWN_DEFAULTS["*"];
}

function readCatalogEntries(payload: CatalogResponse): CatalogModel[] {
  const values = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) return [];
    return [{
      id: item.id.trim(),
      name: typeof item.name === "string" ? item.name : undefined,
      context_window: item.context_window,
      max_tokens: item.max_tokens,
      max_input_tokens: item.max_input_tokens,
      max_output_tokens: item.max_output_tokens,
    }];
  });
}

function toProviderModels(entries: CatalogModel[]): ProviderModelConfig[] {
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);

    const defaults = resolveDefaults(entry.id);
    const contextWindow = positiveNumber(
      entry.context_window,
      entry.max_input_tokens,
      defaults.contextWindow,
    )!;
    const maxTokens = positiveNumber(
      entry.max_output_tokens,
      entry.max_tokens,
      defaults.maxTokens,
    )!;

    models.push({
      id: entry.id,
      name: entry.name?.trim() || entry.id,
      reasoning: defaults.reasoning,
      input: defaults.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      compat: { ...DEFAULT_COMPAT, ...defaults.compat },
    });
  }

  return models;
}

async function fetchModels(serverUrl: string, apiKey: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${serverUrl}/v1/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `x220 returned ${response.status} ${response.statusText}`.trim(),
      };
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "x220 returned a non-object JSON response" };
    }

    const models = toProviderModels(readCatalogEntries(payload as CatalogResponse));
    return models.length > 0
      ? { ok: true, models }
      : { ok: false, error: "x220 returned no valid models from /v1/models" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `cannot load x220 /v1/models: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function registerX220(
  pi: ExtensionAPI,
  serverUrl: string,
  apiKey: string,
  models: ProviderModelConfig[],
): void {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `${serverUrl}/v1`,
    apiKey,
    api: "openai-completions",
    compat: DEFAULT_COMPAT,
    models,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const serverUrl = env("MODELS_SERVER_URL", DEFAULT_SERVER_URL);
  const apiKey = resolveApiKey();

  const refresh = async (): Promise<FetchResult> =>
    fetchModels(serverUrl, apiKey);

  console.error(`[fetch-models] Loading ${serverUrl}/v1/models …`);
  const startup = await refresh();
  if (startup.ok) {
    registerX220(pi, serverUrl, apiKey, startup.models);
    console.error(
      `[fetch-models] Registered ${startup.models.length} model(s) on '${PROVIDER_NAME}'.`,
    );
  } else {
    console.error(`[fetch-models] ${startup.error}`);
  }

  pi.registerCommand("fetch", {
    description: "Reload models from the x220 proxy",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Loading models from ${serverUrl}/v1/models …`, "info");
      const result = await refresh();

      if (!result.ok) {
        console.error(`[fetch-models] /fetch failed: ${result.error}`);
        ctx.ui.notify(result.error, "error");
        return;
      }

      registerX220(pi, serverUrl, apiKey, result.models);
      console.error(
        `[fetch-models] /fetch registered ${result.models.length} model(s): ${result.models.map((m) => m.id).join(", ")}`,
      );
      ctx.ui.notify(`Loaded ${result.models.length} model(s) from x220`, "info");
    },
  });
}
