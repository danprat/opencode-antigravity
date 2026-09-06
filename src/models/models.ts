import { ThinkingEffort } from "../types/enums.js";
import type { AntigravityRouting } from "./types.js";

export type { AntigravityRouting };

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity (Google Cloud Code Assist)";

export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-3.1-pro-low",
  },
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-tiered",
    routing: {
      minimal: "gemini-3.8-flash-tiered",
      low: "gemini-3.8-flash-tiered",
      medium: "gemini-3.8-flash-tiered",
      high: "gemini-3.8-flash-tiered",
      xhigh: "gemini-3.8-flash-tiered",
    },
    defaultRequestId: "gemini-3.8-flash-tiered",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-tiered",
    routing: {
      minimal: "gemini-3.7-flash-tiered",
      low: "gemini-3.7-flash-tiered",
      medium: "gemini-3.7-flash-tiered",
      high: "gemini-3.7-flash-tiered",
      xhigh: "gemini-3.7-flash-tiered",
    },
    defaultRequestId: "gemini-3.7-flash-tiered",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-low",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3.5-flash-extra-low",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gemini-3.8-flash": 65536,
  "gemini-3.8-flash-tiered": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-pro-agent": 65535,
  "gemini-3-pro-image": 32768,
  "claude-sonnet-4-6": 64000,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};

export function getMaxOutputTokens(runtimeModel: string, requestedMaxTokens?: number): number {
  const modelLimit = RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] ?? 65536;
  if (!requestedMaxTokens || requestedMaxTokens <= 0) return modelLimit;
  return Math.min(requestedMaxTokens, modelLimit);
}

let discoveredRouting: Record<string, AntigravityRouting> = {};

export function applyDiscoveredRouting(routing: Record<string, AntigravityRouting>): void {
  discoveredRouting = routing;
}

export function resetDiscoveredRouting(): void {
  discoveredRouting = {};
}

export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
  const r = ANTIGRAVITY_ROUTING[modelId] ?? discoveredRouting[modelId];
  if (!r) return modelId;

  // Unspecified effort matches Antigravity CLI / OpenCode's Gemini default: high.
  if (effort === undefined) {
    return (
      r.routing?.high ??
      r.routing?.xhigh ??
      r.defaultRequestId ??
      r.off ??
      modelId
    );
  }

  if (effort === "off" || effort === "none") {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
  }

  const effortKey = effort.toLowerCase() as ThinkingEffort;
  if (effortKey === ThinkingEffort.XHigh || effortKey === ThinkingEffort.Max) {
    return (
      r.routing?.xhigh ??
      r.routing?.high ??
      r.routing?.low ??
      r.routing?.minimal ??
      r.off ??
      r.defaultRequestId ??
      modelId
    );
  }

  return (
    r.routing?.[effortKey] ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    modelId
  );
}

export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  if (runtimeModel === "gemini-3.8-flash" || runtimeModel.startsWith("gemini-3.8-flash-")) {
    return getAntigravityRequestModelId("gemini-3.7-flash", effort);
  }
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") {
    return "gemini-3.6-flash-low";
  }
  return undefined;
}

export type ThinkingWire = {
  includeThoughts: boolean;
  thinkingBudget: number;
};

export const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = {
  "gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
  "gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
  "gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  "gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

const modelEnumCache = new Map<string, string>();

export function registerDiscoveredModelEnums(models: Record<string, { model?: unknown }>): void {
  for (const [wireId, info] of Object.entries(models)) {
    if (typeof info.model === "string" && info.model) modelEnumCache.set(wireId, info.model);
  }
}

export function getModelEnum(wireModelId: string): string | undefined {
  const direct = modelEnumCache.get(wireModelId) || ANTIGRAVITY_MODEL_ENUM[wireModelId];
  if (direct) return direct;
  const routed = getAntigravityRequestModelId(wireModelId, undefined);
  return modelEnumCache.get(routed) || ANTIGRAVITY_MODEL_ENUM[routed];
}

export function getThinkingConfig(
  modelId: string,
  effort: string | undefined,
): ThinkingWire | undefined {
  const disabled = effort === "off" || effort === "none";
  const enabled = !disabled;
  if (modelId.startsWith("claude-")) {
    return { includeThoughts: enabled, thinkingBudget: enabled ? 1024 : 0 };
  }
  if (modelId.startsWith("gpt-oss-")) {
    return { includeThoughts: enabled, thinkingBudget: enabled ? 8192 : 0 };
  }
  if (modelId.startsWith("gemini-3.8-flash") || modelId.startsWith("gemini-3.7-flash") || modelId.startsWith("gemini-3.6-flash")) {
    if (!enabled) return { includeThoughts: false, thinkingBudget: 0 };
    const normalized = effort?.toLowerCase();
    return { includeThoughts: true, thinkingBudget: normalized === "medium" ? 4_000 : normalized === "low" || normalized === "minimal" || normalized === "min" ? 1_000 : -1 };
  }
  if (modelId.startsWith("gemini-3.5-flash") || modelId === "gemini-3-flash-agent") {
    if (!enabled) return { includeThoughts: false, thinkingBudget: 0 };
    const thinkingBudget =
      !effort || effort === "high" || effort === "xhigh" || effort === "max"
        ? 10_000
        : effort === "medium"
          ? 4_000
          : 1_000;
    return { includeThoughts: true, thinkingBudget };
  }
  if (modelId.startsWith("gemini-3.1-pro") || modelId === "gemini-pro-agent") {
    if (!enabled) return { includeThoughts: false, thinkingBudget: 0 };
    return {
      includeThoughts: true,
      thinkingBudget:
        !effort || effort === "high" || effort === "xhigh" || effort === "max" ? 10_001 : 1_001,
    };
  }
  return undefined;
}
