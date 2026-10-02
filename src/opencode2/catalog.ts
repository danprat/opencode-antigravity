import { pathToFileURL } from "node:url";
import { ANTIGRAVITY_PROVIDER_ID } from "../opencode/plugin-id.js";
import { BUILTIN_ANTIGRAVITY_MODELS } from "../models/catalog.js";
import type { OpenCodeModelConfig } from "../models/types.js";
import type {
  CatalogModelInfo,
  ConnectionInfo,
  ModelVariantInfo,
  ProviderEditor,
} from "./types.js";

/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model IDs, variants, and limits are NOT redefined here: the shared
 * `BUILTIN_ANTIGRAVITY_MODELS` catalog (plus the live-discovery overlay, which
 * produces the same shape) is translated into the 2.0 `Model.Info` shape, so
 * every surface exposes an identical model list.
 */

/** Integration id owning Antigravity credentials. Matches the provider id. */
export const ANTIGRAVITY_INTEGRATION_ID = ANTIGRAVITY_PROVIDER_ID;

/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points this plugin supplies
 * the provider through. The suffix is this package's npm name so the host's
 * built-in fallback can still resolve it if the `sdk` hook is ever bypassed —
 * that fallback installs the *published* package into the host cache.
 *
 * `ANTIGRAVITY_OPENCODE2_DEV_ENTRY` overrides the suffix with an
 * `aisdk:file://…` spec instead, pointed at a local built entry file (e.g.
 * `dist/sdk.js`, which exports `createAntigravity`). The host imports `file://`
 * specs directly, skipping the npm install — the only way to exercise a local
 * build through that fallback path short of publishing. Unset in production.
 */
export const ANTIGRAVITY_AISDK_PACKAGE = process.env.ANTIGRAVITY_OPENCODE2_DEV_ENTRY
  ? `aisdk:${pathToFileURL(process.env.ANTIGRAVITY_OPENCODE2_DEV_ENTRY).href}`
  : "aisdk:@danprat/opencode-antigravity";

/** Translate one catalog entry's variants into the 2.0 `variants` shape. */
export function catalogVariantsToInfo(
  variants: OpenCodeModelConfig["variants"],
): ModelVariantInfo[] {
  if (!variants) return [];
  return Object.entries(variants).map(([id, settings]) => ({
    id,
    settings: { ...(settings as Record<string, unknown>) },
  }));
}

/** Translate one `OpenCodeModelConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(id: string, entry: OpenCodeModelConfig): CatalogModelInfo {
  const input = entry.modalities?.input ?? ["text"];
  const output = entry.modalities?.output ?? ["text"];
  return {
    id,
    // No synthetic ids here: every public id addresses the same-named backend
    // model, and per-effort routing happens inside the language model
    // (`getAntigravityRequestModelId`). `modelID` stays equal to `id` so the
    // `language` hook can pass it straight to `createAntigravityLanguageModel`.
    modelID: id,
    providerID: ANTIGRAVITY_PROVIDER_ID,
    name: entry.name ?? id,
    capabilities: {
      tools: true,
      input: [...input],
      output: [...output],
    },
    limit: {
      context: entry.limit?.context ?? 200_000,
      output: entry.limit?.output ?? 65_536,
    },
    variants: catalogVariantsToInfo(entry.variants),
    status: "active",
    enabled: true,
    // Antigravity does not publish release dates; Cursor's 2.0 plugin uses 0
    // for the same reason. Models sort last in the picker — filter by
    // provider Antigravity.
    time: { released: 0 },
    // Cloud Code Assist draws from shared quota pools, not per-token billing.
    cost: [],
  };
}

/** Full model map for the in-memory provider inventory. */
export function modelsToCatalogModelMap(
  models: Record<string, OpenCodeModelConfig>,
): Record<string, CatalogModelInfo> {
  const out: Record<string, CatalogModelInfo> = {};
  for (const [id, entry] of Object.entries(models)) {
    out[id] = modelConfigEntryToInfo(id, entry);
  }
  return out;
}

/** Static catalog for startup (no network), mirroring V1 `config()`. */
export function staticCatalogModels(): Record<string, OpenCodeModelConfig> {
  return { ...BUILTIN_ANTIGRAVITY_MODELS };
}

/**
 * Publish Antigravity models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register), replace the definition with `editor.add`,
 * then `ctx.provider.reload()`.
 */
export function applyAntigravityProviderInventory(
  editor: ProviderEditor,
  models: Record<string, OpenCodeModelConfig>,
  sourceConnection?: ConnectionInfo,
): void {
  if (Object.keys(models).length === 0) return;

  editor.add({
    info: {
      id: ANTIGRAVITY_PROVIDER_ID,
      name: "Antigravity",
      activation: "enabled",
      package: ANTIGRAVITY_AISDK_PACKAGE,
      integrationID: ANTIGRAVITY_INTEGRATION_ID,
    },
    models: Object.values(modelsToCatalogModelMap(models)),
    ...(sourceConnection ? { sourceConnection } : {}),
  });
}
