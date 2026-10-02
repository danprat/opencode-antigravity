import { ANTIGRAVITY_PROVIDER_ID } from "./opencode/plugin-id.js";
import { AntigravityPlugin } from "./opencode/plugin.js";
import { createAntigravityLanguageModel } from "./opencode/language-model.js";
import { modelsToOpenCodeConfig } from "./models/catalog.js";
import { loadLiveOpenCodeModels } from "./models/discovery.js";
import type { OpenCodeModelConfig } from "./models/types.js";
import {
  ANTIGRAVITY_AISDK_PACKAGE,
  ANTIGRAVITY_INTEGRATION_ID,
  applyAntigravityProviderInventory,
  staticCatalogModels,
} from "./opencode2/catalog.js";
import { applyAntigravityIntegration, resolveAntigravityAccessToken } from "./opencode2/integration.js";
import { createAntigravityToolDefinitions } from "./opencode2/tools.js";
import { registerAntigravityCommands } from "./opencode2/commands.js";
import type { Cleanup, Plugin2, PluginContext } from "./opencode2/types.js";

/**
 * OpenCode 2.0 plugin.
 *
 * Separate from the classic entrypoint on purpose: the OpenCode 1.x Hooks API
 * (`@opencode-ai/plugin`: `config`/`tool`/`provider`/`auth` returns) and the
 * 2.0 API (`ctx.provider.transform`, `ctx.integration.transform`,
 * `ctx.aisdk.hook`, …) are source-incompatible, so they cannot share an
 * implementation. Shared behavior (OAuth PKCE, streaming, model catalog,
 * image generation, quota) lives in the host-neutral modules this file
 * reuses unchanged.
 *
 * Models register in memory via `ctx.provider.transform` + `editor.add` +
 * `reload()`. Nothing is written into `opencode.json`.
 *
 * Dual export: `{ id, setup, server: AntigravityPlugin }`. OpenCode 2.0
 * Host.resolve loads `./server` then calls `setup()`. OpenCode 1.18 also
 * prefers `exports["./server"]` and then calls `server()`, so classic 1.x
 * hooks still run from the same module.
 *
 * Load with:  { "plugins": ["@danprat/opencode-antigravity/plugin/opencode2"] }
 */

export const ANTIGRAVITY_V2_PLUGIN_ID = "antigravity.provider";

/** Whether an `aisdk` package string refers to this provider. */
export function isAntigravityPackage(pkg: string, providerID: string): boolean {
  if (providerID === ANTIGRAVITY_PROVIDER_ID) return true;
  return (
    pkg.includes("@danprat/opencode-antigravity") ||
    pkg.includes("@rahularya01/opencode-antigravity") ||
    /opencode-antigravity[/\\]dist[/\\](sdk|index)\.js/.test(pkg)
  );
}

const plugin: Plugin2 & { server: typeof AntigravityPlugin } = {
  id: ANTIGRAVITY_V2_PLUGIN_ID,
  server: AntigravityPlugin,

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const workspaceRoot = ctx.location?.directory || process.cwd();
    const registrations: Array<{ dispose: () => Promise<void> }> = [];
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p);
    };

    let models: Record<string, OpenCodeModelConfig> = staticCatalogModels();
    let sourceConnection: { type: string; id?: string; [key: string]: unknown } | undefined;

    // ── Credentials ─────────────────────────────────────────
    await track(ctx.integration.transform(applyAntigravityIntegration));

    let cachedToken: string | undefined;
    let tokenInflight: Promise<string | undefined> | undefined;
    // Cache only a *successful* resolution. On a fresh install `setup()` runs
    // before the user has connected, so the first attempt necessarily returns
    // nothing — memoizing that would pin "no credentials" for the process.
    const accessToken = async (): Promise<string | undefined> => {
      if (cachedToken) return cachedToken;
      tokenInflight ??= resolveAntigravityAccessToken(ctx.integration).finally(() => {
        tokenInflight = undefined;
      });
      const token = await tokenInflight;
      if (token) cachedToken = token;
      return token;
    };

    const refreshSourceConnection = async (): Promise<void> => {
      try {
        sourceConnection = await ctx.integration.connection.active(ANTIGRAVITY_INTEGRATION_ID);
      } catch {
        sourceConnection = undefined;
      }
    };

    // ── Provider inventory (in-memory `editor.add`) ─────────────────────
    // The static catalog registers synchronously so models are selectable
    // before first login; discovery overlays the live list afterwards.
    await track(
      ctx.provider.transform((editor) => {
        applyAntigravityProviderInventory(editor, models, sourceConnection);
      }),
    );

    const publishModels = async (next: Record<string, OpenCodeModelConfig>): Promise<boolean> => {
      const previousModels = models;
      const previousConnection = sourceConnection;
      models = next;
      await refreshSourceConnection();
      try {
        await ctx.provider.reload();
        return true;
      } catch {
        models = previousModels;
        sourceConnection = previousConnection;
        return false;
      }
    };

    // ── AI SDK wiring ────────────────────────────────────────
    // Tokens resolve per request (env, then the active connection), so a
    // late `/connect` or credential switch applies to the next call without
    // rebuilding the model.
    const liveToken = async (): Promise<string> => {
      const token = await accessToken();
      if (!token) {
        throw new Error("No Antigravity credentials. Run `/connect` and choose Antigravity.");
      }
      return token;
    };
    await track(
      ctx.aisdk.hook("sdk", async (event) => {
        if (event.sdk) return;
        if (!isAntigravityPackage(event.package, event.model.providerID)) return;
        const providerID = event.model.providerID || ANTIGRAVITY_PROVIDER_ID;
        event.sdk = {
          languageModel: (modelId: string) =>
            createAntigravityLanguageModel(modelId, providerID, {}, liveToken),
        };
      }),
    );

    await track(
      ctx.aisdk.hook("language", (event) => {
        if (event.language) return;
        if (event.model.providerID !== ANTIGRAVITY_PROVIDER_ID) return;
        const sdk = event.sdk as
          | { languageModel?: (modelId: string) => unknown }
          | undefined;
        if (typeof sdk?.languageModel === "function") {
          // `modelID` is the backend wire id; `id` is the public catalog id.
          event.language = sdk.languageModel(event.model.modelID || event.model.id);
          return;
        }
        event.language = createAntigravityLanguageModel(
          event.model.modelID || event.model.id,
          ANTIGRAVITY_PROVIDER_ID,
          {},
          liveToken,
        );
      }),
    );

    // ── Tools ────────────────────────────────────────────────
    const resolveDirectory = async (sessionID?: string): Promise<string> => {
      if (sessionID) {
        try {
          const info = await ctx.session.get({ sessionID });
          if (info.location?.directory) return info.location.directory;
        } catch {
          // Fall through to the static root.
        }
      }
      return workspaceRoot;
    };
    const requireAccessToken = async (): Promise<string> => {
      const token = await accessToken();
      if (!token) {
        throw new Error("No Antigravity credentials. Run `/connect` and choose Antigravity.");
      }
      return token;
    };
    await track(
      ctx.tool.transform((draft) => {
        for (const tool of createAntigravityToolDefinitions({
          requireAccessToken,
          resolveDirectory,
        })) {
          draft.add(tool);
        }
      }),
    );

    // ── Commands ─────────────────────────────────────────────
    if (ctx.command) {
      await track(
        ctx.command.transform((draft) => {
          registerAntigravityCommands(draft, ctx);
        }),
      );
    }

    // ── Model discovery ──────────────────────────────────────
    let modelsLoaded = false;
    let credentialGeneration = 0;
    let loadedCredentialGeneration = 0;
    let ensureInflight: Promise<void> | undefined;
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded && loadedCredentialGeneration === credentialGeneration) {
        return Promise.resolve();
      }
      if (ensureInflight) return ensureInflight.then(() => ensureModels());

      const attemptGeneration = credentialGeneration;
      const forceRefresh = loadedCredentialGeneration !== attemptGeneration;
      ensureInflight = (async () => {
        try {
          const token = await accessToken();
          // Without a token the static catalog is already published; there
          // is nothing live to discover.
          if (!token) return;
          let discovered: Record<string, OpenCodeModelConfig>;
          try {
            discovered = await loadLiveOpenCodeModels(token);
          } catch {
            // Static catalog stays live; retry on the next trigger.
            discovered = modelsToOpenCodeConfig();
          }
          if (Object.keys(discovered).length === 0) return;
          if (credentialGeneration !== attemptGeneration) return;
          if (!(await publishModels(discovered))) return;
          if (credentialGeneration !== attemptGeneration) return;
          modelsLoaded = true;
          loadedCredentialGeneration = attemptGeneration;
        } finally {
          ensureInflight = undefined;
        }
      })();
      return ensureInflight;
    };

    const RETRY_INTERVAL_MS = 30_000;
    const RETRY_WINDOW_MS = 300_000;
    const startedAt = Date.now();
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry);
        return;
      }
      void ensureModels().catch(() => {});
    }, RETRY_INTERVAL_MS);
    (retry as unknown as { unref?: () => void }).unref?.();

    // Static inventory is already registered; kick off live discovery in the
    // background without blocking setup.
    void ensureModels().catch(() => {});

    const onCredentialSwitch = () => {
      cachedToken = undefined;
      modelsLoaded = false;
      credentialGeneration++;
    };

    // Re-run discovery on session/credential activity; a switch clears the
    // token cache so the next attempt uses the new account.
    let stopped = false;
    try {
      const stream = ctx.event.subscribe();
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        void (async () => {
          for await (const event of stream as AsyncIterable<{ type?: string }>) {
            if (stopped) break;
            if (event?.type === "credential.switched" || event?.type === "credential.updated") {
              onCredentialSwitch();
            }
            void ensureModels().catch(() => {});
          }
        })().catch(() => {});
      }
    } catch {
      // Event subscription is best-effort.
    }

    return async () => {
      stopped = true;
      clearInterval(retry);
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {});
      }
    };
  },
};

export default plugin;
