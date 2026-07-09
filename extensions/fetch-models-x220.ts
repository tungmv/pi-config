/**
 * Fetch Models from localhost:4000 — pi Extension
 *
 * Dynamically fetches available models from a local OpenAI-compatible
 * server at http://localhost:4000 and registers them as a pi provider
 * with sensible defaults matched against known model families.
 *
 * The provider is registered inside the async factory so models are visible
 * during interactive startup and via `pi --list-models`.
 *
 * Usage:
 *   pi -e ./fetch-models-localhost.ts
 *   pi --list-models -e ./fetch-models-localhost.ts
 *
 * Then use /model to select localhost/<model-id>.
 *
 * Configuration:
 *   - Server URL:     process.env.MODELS_SERVER_URL  or  "http://x220:4000"
 *   - API Key:        process.env.MODELS_API_KEY     or  "local" (dummy)
 *   - Provider name:  "x220"
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Resolve env var with a fallback, stripping trailing slashes from URLs. */
function env(key: string, fallback: string): string {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  return key.endsWith("URL") ? raw.replace(/\/+$/, "") : raw;
}

// ---------------------------------------------------------------------------
// Known model defaults — matched by substring against the model id.
// Lowercase key → defaults.  First match wins, so order more-specific first.
// ---------------------------------------------------------------------------
interface ModelDefaults {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  compat?: ProviderModelConfig["compat"];
}

const KNOWN_DEFAULTS: Record<string, ModelDefaults> = {
  // GPT / OpenAI family
  "gpt-5": {
    contextWindow: 200_000,
    maxTokens: 200_000,
    reasoning: true,
    input: ["text", "image"],
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
  },
  gpt: {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },

  // Claude / Anthropic family
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

  // DeepSeek family
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
  deepseek: {
    contextWindow: 128_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text"],
  },

  // GLM family
  "glm-5.2": {
    contextWindow: 200_000,
    maxTokens: 200_000,
    reasoning: true,
    input: ["text", "image"],
  },
  glm: {
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },

  // Kimi family
  "kimi-k2.6": {
    contextWindow: 262_144,
    maxTokens: 262_144,
    reasoning: true,
    input: ["text", "image"],
  },
  kimi: {
    contextWindow: 128_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text"],
  },

  // HY (Yi) family
  hy: {
    contextWindow: 200_000,
    maxTokens: 200_000,
    reasoning: true,
    input: ["text"],
  },

  // Generic fallback (applied last if nothing matched)
  "*": {
    contextWindow: 200_000,
    maxTokens: 200_000,
    reasoning: false,
    input: ["text"],
  },
};

/** Pick the best defaults for a model id (first key whose value is a substring of the lowercase id). */
function resolveDefaults(id: string): ModelDefaults {
  const lower = id.toLowerCase();
  for (const [key, defs] of Object.entries(KNOWN_DEFAULTS)) {
    if (key === "*") continue; // defer
    if (lower.includes(key)) return defs;
  }
  return KNOWN_DEFAULTS["*"];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default async function (pi: ExtensionAPI): Promise<void> {
  const serverUrl = env("MODELS_SERVER_URL", "http://x220:4000");
  const apiKey = env("MODELS_API_KEY", "local");

  console.error(`[fetch-models] Fetching models from ${serverUrl}/v1/models …`);

  // Fetch the OpenAI-compatible /v1/models endpoint
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.error(
      `[fetch-models] Failed to reach ${serverUrl}/v1/models:`,
      (err as Error).message,
    );
    return;
  }

  if (!response.ok) {
    console.error(
      `[fetch-models] Server returned ${response.status} ${response.statusText}`,
    );
    return;
  }

  const payload = (await response.json()) as {
    data?: Array<{ id: string; object?: string; owned_by?: string }>;
    models?: Array<{ id: string; name?: string }>;
  };

  const rawModels: Array<{ id: string; name?: string }> =
    payload.data ?? payload.models ?? [];

  if (rawModels.length === 0) {
    console.error("[fetch-models] No models returned by the server.");
    return;
  }

  console.error(`[fetch-models] Found ${rawModels.length} model(s).`);

  // Build model configs with matched defaults
  const providerCompat = {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens" as const,
  };

  const models = rawModels.map((m) => {
    const defs = resolveDefaults(m.id);
    const modelCompat = defs.compat ?? {};
    return {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: defs.reasoning,
      input: defs.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: defs.contextWindow,
      maxTokens: defs.maxTokens,
      // Merge per-model compat on top of provider defaults
      compat: { ...providerCompat, ...modelCompat },
    } satisfies ProviderModelConfig;
  });

  pi.registerProvider("x220", {
    baseUrl: `${serverUrl}/v1`,
    apiKey,
    api: "openai-completions",
    compat: providerCompat,
    models,
  });

  console.error("[fetch-models] Provider 'x220' registered successfully.");
}
