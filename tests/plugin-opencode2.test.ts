import { describe, expect, it } from "bun:test";
import plugin, {
  ANTIGRAVITY_V2_PLUGIN_ID,
  isAntigravityPackage,
} from "../src/plugin-opencode2.js";
import { applyAntigravityIntegration } from "../src/opencode2/integration.js";
import {
  ANTIGRAVITY_AISDK_PACKAGE,
  modelConfigEntryToInfo,
  staticCatalogModels,
} from "../src/opencode2/catalog.js";
import { BUILTIN_ANTIGRAVITY_MODELS } from "../src/models/catalog.js";

function makeCaptures() {
  const providerAdds: Array<any> = [];
  const methodUpdates: Array<any> = [];
  const integrationUpdates: Array<any> = [];
  const tools: Array<any> = [];
  const aisdkHooks: Record<string, (event: any) => unknown> = {};
  const commands: Array<any> = [];

  const ctx: any = {
    location: { directory: "/tmp/test-workspace" },
    integration: {
      transform: async (cb: any) => {
        cb({
          update: (id: string, fn: any) => {
            const ref: any = { id, name: id };
            fn(ref);
            integrationUpdates.push(ref);
          },
          method: { update: (input: any) => methodUpdates.push(input) },
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    provider: {
      transform: async (cb: any) => {
        cb({ add: (input: any) => providerAdds.push(input) });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    aisdk: {
      hook: async (name: string, cb: any) => {
        aisdkHooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (cb: any) => {
        cb({ add: (tool: any) => tools.push(tool) });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    command: {
      transform: async (cb: any) => {
        cb({ add: (cmd: any) => commands.push(cmd) });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async () => ({ id: "ses_test", location: { directory: "/tmp/test-workspace" } }),
      prompt: async () => ({}),
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
  };

  return { ctx, providerAdds, methodUpdates, integrationUpdates, tools, aisdkHooks, commands };
}

describe("isAntigravityPackage", () => {
  it("matches by provider id", () => {
    expect(isAntigravityPackage("aisdk:something-else", "antigravity")).toBe(true);
  });
  it("matches by package specifier", () => {
    expect(isAntigravityPackage("aisdk:@danprat/opencode-antigravity", "other")).toBe(true);
    expect(isAntigravityPackage("aisdk:@rahularya01/opencode-antigravity", "other")).toBe(true);
  });
  it("rejects unrelated packages", () => {
    expect(isAntigravityPackage("aisdk:some-provider", "other")).toBe(false);
  });
});

describe("OpenCode 2.0 plugin entry", () => {
  it("exports id, setup, and the classic server for dual loading", () => {
    expect(plugin.id).toBe(ANTIGRAVITY_V2_PLUGIN_ID);
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("registers the static catalog synchronously during setup", async () => {
    const { ctx, providerAdds } = makeCaptures();
    const cleanup = await plugin.setup(ctx);
    expect(providerAdds.length).toBe(1);
    const [inventory] = providerAdds;
    expect(inventory.info.id).toBe("antigravity");
    expect(inventory.info.activation).toBe("enabled");
    expect(inventory.info.package).toBe(ANTIGRAVITY_AISDK_PACKAGE);
    expect(inventory.info.integrationID).toBe("antigravity");
    const ids = inventory.models.map((m: any) => m.id).sort();
    expect(ids).toEqual(Object.keys(BUILTIN_ANTIGRAVITY_MODELS).sort());
    for (const model of inventory.models) {
      expect(model.providerID).toBe("antigravity");
      expect(model.modelID).toBe(model.id);
      expect(model.status).toBe("active");
      expect(model.enabled).toBe(true);
    }
    await (cleanup as () => Promise<void>)();
  });

  it("registers oauth, key, and env integration methods", async () => {
    const { ctx, methodUpdates, integrationUpdates } = makeCaptures();
    const cleanup = await plugin.setup(ctx);
    expect(integrationUpdates.map((i: any) => i.id)).toContain("antigravity");
    const methods = methodUpdates.map((m: any) => m.method.type).sort();
    expect(methods).toEqual(["env", "key", "oauth"]);
    const oauth = methodUpdates.find((m: any) => m.method.type === "oauth");
    expect(oauth.integrationID).toBe("antigravity");
    expect(typeof oauth.authorize).toBe("function");
    expect(typeof oauth.refresh).toBe("function");
    await (cleanup as () => Promise<void>)();
  });

  it("registers the three tools and three commands", async () => {
    const { ctx, tools, commands } = makeCaptures();
    const cleanup = await plugin.setup(ctx);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "antigravity_models",
      "antigravity_usage",
      "generate_image",
    ]);
    expect(commands.map((c: any) => c.name).sort()).toEqual([
      "antigravity-image",
      "antigravity-models",
      "antigravity-usage",
    ]);
    await (cleanup as () => Promise<void>)();
  });

  it("language hook builds a LanguageModelV3 for antigravity models", async () => {
    const { ctx, aisdkHooks } = makeCaptures();
    const cleanup = await plugin.setup(ctx);
    expect(typeof aisdkHooks.sdk).toBe("function");
    const languageHook = aisdkHooks.language;
    if (!languageHook) throw new Error("language hook not registered");

    const event: any = {
      model: { id: "gemini-3.7-flash", modelID: "gemini-3.7-flash", providerID: "antigravity" },
      sdk: {
        languageModel: (modelId: string) => ({ via: "sdk", modelId }),
      },
      options: {},
    };
    await languageHook(event);
    expect(event.language).toEqual({ via: "sdk", modelId: "gemini-3.7-flash" });

    // Without an sdk, the hook falls back to the built-in language model.
    const fallback: any = {
      model: { id: "gemini-3.7-flash", modelID: "gemini-3.7-flash", providerID: "antigravity" },
      options: {},
    };
    await languageHook(fallback);
    expect(fallback.language.specificationVersion).toBe("v3");
    expect(fallback.language.modelId).toBe("gemini-3.7-flash");

    // Other providers are ignored.
    const other: any = {
      model: { id: "x", modelID: "x", providerID: "openai" },
      options: {},
    };
    await languageHook(other);
    expect(other.language).toBeUndefined();
    await (cleanup as () => Promise<void>)();
  });

  it("tools fail clearly without credentials", async () => {
    const { ctx, tools } = makeCaptures();
    const cleanup = await plugin.setup(ctx);
    const usage = tools.find((t: any) => t.name === "antigravity_usage");
    await expect(usage.execute({}, {})).rejects.toThrow(/\/connect/);
    await (cleanup as () => Promise<void>)();
  });
});

describe("opencode2 catalog mapping", () => {
  it("maps every static entry with variants and limits", () => {
    const models = staticCatalogModels();
    expect(Object.keys(models).length).toBeGreaterThan(0);
    for (const [id, entry] of Object.entries(models)) {
      const info = modelConfigEntryToInfo(id, entry);
      expect(info.id).toBe(id);
      expect(info.modelID).toBe(id);
      expect(info.limit.context).toBe(entry.limit?.context ?? 200_000);
      expect(info.limit.output).toBe(entry.limit?.output ?? 65_536);
      expect(info.capabilities.input).toEqual(entry.modalities?.input ?? ["text"]);
      expect(Object.keys(Object.fromEntries(info.variants.map((v) => [v.id, v])))).toEqual(
        Object.keys(entry.variants ?? {}),
      );
    }
  });
});

describe("opencode2 integration", () => {
  it("registers integration without starting OAuth", () => {
    const updates: Array<any> = [];
    const methods: Array<any> = [];
    applyAntigravityIntegration({
      update: (id: string, fn: any) => {
        const ref: any = { id, name: id };
        fn(ref);
        updates.push(ref);
      },
      method: { update: (input: any) => methods.push(input) },
    } as never);
    expect(updates[0].name).toBe("Antigravity");
    expect(methods.length).toBe(3);
  });
});
