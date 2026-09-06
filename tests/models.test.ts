import { describe, expect, it } from "bun:test";
import {
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getMaxOutputTokens,
  getThinkingConfig,
  ANTIGRAVITY_ROUTING,
  getModelEnum,
  registerDiscoveredModelEnums,
} from "../src/models/models.js";
import { fallbackModelConfig, modelsToOpenCodeConfig } from "../src/models/catalog.js";

describe("Models & Catalog", () => {
  it("routes public model IDs and thinking levels to Antigravity runtime IDs", () => {
    expect(getAntigravityRequestModelId("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-tiered");
    expect(getAntigravityRequestModelId("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-tiered");
    expect(getAntigravityRequestModelId("gemini-3.7-flash", "low")).toBe("gemini-3.7-flash-tiered");
    expect(getAntigravityRequestModelId("gemini-3.7-flash", "high")).toBe("gemini-3.7-flash-tiered");
    expect(getAntigravityRequestModelId("gemini-3.1-pro", "high")).toBe("gemini-pro-agent");
    expect(getAntigravityRequestModelId("claude-opus-4-6", "high")).toBe("claude-opus-4-6-thinking");
    expect(getAntigravityRequestModelId("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
  });

  it("defaults unspecified effort to high, matching Antigravity CLI", () => {
    expect(getAntigravityRequestModelId("gemini-3.6-flash", undefined)).toBe("gemini-3.6-flash-high");
    expect(getAntigravityRequestModelId("gemini-3.1-pro", undefined)).toBe("gemini-pro-agent");
    expect(getAntigravityRequestModelId("gemini-3.6-flash", "off")).toBe("gemini-3.6-flash-low");
    expect(getThinkingConfig("gemini-3.8-flash", undefined)?.thinkingBudget).toBe(-1);
    expect(getThinkingConfig("gemini-3.8-flash", "minimal")?.thinkingBudget).toBe(1_000);
    expect(getThinkingConfig("gemini-3.5-flash", undefined)?.thinkingBudget).toBe(10_000);
  });

  it("provides thinking configuration for supported models", () => {
    const flash38Thinking = getThinkingConfig("gemini-3.8-flash", "high");
    expect(flash38Thinking?.includeThoughts).toBe(true);
    expect(flash38Thinking?.thinkingBudget).toBe(-1);

    const flashThinking = getThinkingConfig("gemini-3.7-flash", "high");
    expect(flashThinking?.includeThoughts).toBe(true);
    expect(flashThinking?.thinkingBudget).toBe(-1);

    expect(getThinkingConfig("claude-sonnet-4-6", "high")?.thinkingBudget).toBe(1024);
    expect(getThinkingConfig("gpt-oss-120b", "high")?.thinkingBudget).toBe(8192);

    const flash35Thinking = getThinkingConfig("gemini-3.5-flash", "medium");
    expect(flash35Thinking?.includeThoughts).toBe(true);
    expect(flash35Thinking?.thinkingBudget).toBe(4000);
  });

  it("handles fallback runtime models on missing entities", () => {
    expect(getFallbackRuntimeModel("gemini-3.8-flash-tiered")).toBe("gemini-3.7-flash-tiered");
    expect(getFallbackRuntimeModel("gemini-3.8-flash-low")).toBe("gemini-3.7-flash-tiered");
    expect(getFallbackRuntimeModel("gemini-3.7-flash-tiered")).toBe("gemini-3.6-flash-high");
    expect(getFallbackRuntimeModel("gemini-3.7-flash-low")).toBe("gemini-3.6-flash-low");
  });

  it("caps maxOutputTokens according to verified runtime limits", () => {
    expect(getMaxOutputTokens("gemini-3.8-flash", 100_000)).toBe(65536);
    expect(getMaxOutputTokens("gemini-3.7-flash", 100_000)).toBe(65536);
    expect(getMaxOutputTokens("gemini-3.7-flash", 2048)).toBe(2048);
    expect(getMaxOutputTokens("claude-sonnet-4-6", 70_000)).toBe(64000);
  });

  it("prefers model enums discovered from the live catalog", () => {
    registerDiscoveredModelEnums({ "gemini-3.8-flash-tiered": { model: "MODEL_DISCOVERED" } });
    expect(getModelEnum("gemini-3.8-flash-tiered")).toBe("MODEL_DISCOVERED");
  });

  it("exports valid OpenCode model config map", () => {
    const config = fallbackModelConfig();
    expect(config["gemini-3.8-flash"]).toBeDefined();
    expect(config["gemini-3.8-flash"]?.reasoning).toBe(true);
    expect(config["gemini-3.8-flash"]?.limit?.context).toBe(1_048_576);
    expect(config["gemini-3.7-flash"]).toBeDefined();
    expect(config["gemini-3.7-flash"]?.reasoning).toBe(true);
    expect(config["gemini-3.7-flash"]?.limit?.context).toBe(1_048_576);
    expect(config["claude-sonnet-4-6"]).toBeDefined();
    expect(config["gpt-oss-120b"]).toBeDefined();
  });
});
