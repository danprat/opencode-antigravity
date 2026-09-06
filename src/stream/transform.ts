import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  SharedV3Warning,
} from "@ai-sdk/provider";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
} from "../types/enums.js";
import type {
  AntigravityGenerateRequest,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiFunctionResponsePart,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiRequestBody,
  GeminiTool,
} from "../types/types.js";
import {
  getAntigravityRequestModelId,
  getMaxOutputTokens,
  getThinkingConfig,
} from "../models/models.js";
import { antigravityRequestEnvelope, asString, isRecord, sanitizeText } from "../utils/util.js";

export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const DEFAULT_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding. " +
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n" +
  "**Absolute paths only**\n" +
  "Do the work yourself with read, glob, grep, edit, and bash. Do not call the task tool or spawn a nested Build/Plan agent.";

const AGENT_EFFICIENCY_INSTRUCTION =
  "CRITICAL BEHAVIORAL & EXECUTION GUIDELINES:\n" +
  "1. NEVER END A TURN SILENTLY: You must ALWAYS provide a visible text response to the user. Never end your turn with internal thoughts alone. After tool executions or inspections, explain clearly what you completed and what the next steps are.\n" +
  "2. PERSISTENT TASK EXECUTION: If the user asked you to implement code or perform a multi-step task, do not stop prematurely after one or two file operations. Continue calling the next tools needed until the implementation is complete.\n" +
  "3. EFFICIENT INSPECTIONS: When using `read`, inspect full files or large sections. Do NOT paginate in 50-100 line chunks with offset/limit unless the file exceeds 1,000 lines. Never re-read files you already viewed.\n" +
  "4. PARALLELIZE INDEPENDENT TOOLS: Execute independent tool calls (such as reading or writing multiple files) in parallel in a single turn instead of serializing across separate turns.";

let toolCallCounter = 0;

function thoughtSignatureFromMeta(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const meta = isRecord(part.providerMetadata)
    ? part.providerMetadata
    : isRecord(part.metadata)
      ? part.metadata
      : undefined;
  if (!meta) return undefined;
  for (const key of ["google", "antigravity", "gemini"]) {
    const inner = meta[key];
    if (isRecord(inner) && typeof inner.thoughtSignature === "string" && inner.thoughtSignature.trim()) {
      return inner.thoughtSignature.trim();
    }
  }
  return undefined;
}

/**
 * Tool-call arguments replayed out of history are not guaranteed to parse — a
 * truncated stream or a provider that emitted invalid JSON both land here. A
 * throw would take down every later turn in the session that replays the same
 * message, so degrade to empty arguments instead.
 */
function parseToolCallInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input;
  if (typeof input !== "string" || !input.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function parseImageData(raw: string | Uint8Array, explicitMime?: string): { data: string; mimeType: string } | undefined {
  if (raw instanceof Uint8Array) {
    return {
      mimeType: explicitMime || "image/png",
      data: Buffer.from(raw).toString("base64"),
    };
  }
  if (typeof raw === "string") {
    const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
    if (match && match[1] && match[2]) {
      return {
        mimeType: explicitMime || match[1],
        data: match[2].trim(),
      };
    }
    return {
      mimeType: explicitMime || "image/png",
      data: raw.trim(),
    };
  }
  return undefined;
}

type SchemaReferenceIssue = {
  path: string;
  ref: string;
  reason: string;
};

type DereferencedSchema = {
  schema: unknown;
  issues: SchemaReferenceIssue[];
};

type DereferenceState = {
  nodes: number;
};

const MAX_SCHEMA_DEREFERENCE_DEPTH = 64;
const MAX_SCHEMA_DEREFERENCE_NODES = 10_000;
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve a local RFC 6901 JSON Pointer against the original tool schema. */
function resolveLocalJsonPointer(ref: string, rootSchema: unknown): unknown {
  if (ref === "#") return rootSchema;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = rootSchema;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function dereferenceSchemaMap(
  schemaMap: unknown,
  rootSchema: unknown,
  refStack: Set<string>,
  objectStack: Set<object>,
  state: DereferenceState,
  path: string,
  depth: number,
): DereferencedSchema {
  if (!isRecord(schemaMap)) {
    return dereferenceSchema(schemaMap, rootSchema, refStack, objectStack, state, path, depth);
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(schemaMap)) {
    const result = dereferenceSchema(
      value,
      rootSchema,
      refStack,
      objectStack,
      state,
      `${path}.${key}`,
      depth,
    );
    out[key] = result.schema;
    issues.push(...result.issues);
  }
  return { schema: out, issues };
}

/**
 * Inline reachable local references while bounding expansion of schemas.
 * A reported issue causes only the affected tool declaration to be omitted.
 */
function dereferenceSchema(
  schema: unknown,
  rootSchema: unknown = schema,
  refStack = new Set<string>(),
  objectStack = new Set<object>(),
  state: DereferenceState = { nodes: 0 },
  path = "$",
  depth = 0,
): DereferencedSchema {
  if (depth > MAX_SCHEMA_DEREFERENCE_DEPTH) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(depth limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_DEPTH} levels`,
        },
      ],
    };
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_DEREFERENCE_NODES) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(node limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_NODES} nodes`,
        },
      ],
    };
  }
  if (!schema || typeof schema !== "object") return { schema, issues: [] };

  if (Array.isArray(schema)) {
    const results = schema.map((item, index) =>
      dereferenceSchema(
        item,
        rootSchema,
        refStack,
        objectStack,
        state,
        `${path}[${index}]`,
        depth + 1,
      ),
    );
    return {
      schema: results.map((result) => result.schema),
      issues: results.flatMap((result) => result.issues),
    };
  }

  const s = schema as Record<string, unknown>;
  if (objectStack.has(s)) {
    return {
      schema: {},
      issues: [{ path, ref: "(object cycle)", reason: "circular schema object" }],
    };
  }

  const nextObjectStack = new Set(objectStack);
  nextObjectStack.add(s);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (refStack.has(ref)) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "circular local reference" }],
      };
    }

    const target = resolveLocalJsonPointer(ref, rootSchema);
    if (target === undefined) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "target is not present in the root schema" }],
      };
    }

    const nextRefStack = new Set(refStack);
    nextRefStack.add(ref);
    const resolved = dereferenceSchema(
      target,
      rootSchema,
      nextRefStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );
    const { $ref: _, ...siblings } = s;
    const siblingResult = dereferenceSchema(
      siblings,
      rootSchema,
      refStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );

    if (isRecord(resolved.schema) && isRecord(siblingResult.schema)) {
      return {
        schema: { ...resolved.schema, ...siblingResult.schema },
        issues: [...resolved.issues, ...siblingResult.issues],
      };
    }
    return {
      schema: resolved.schema,
      issues: [...resolved.issues, ...siblingResult.issues],
    };
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (key === "$defs" || key === "definitions") continue;

    let result: DereferencedSchema | undefined;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      result = dereferenceSchemaMap(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      result = dereferenceSchema(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    }

    if (result) {
      out[key] = result.schema;
      issues.push(...result.issues);
    } else {
      out[key] = value;
    }
  }
  return { schema: out, issues };
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

const META_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

function stripMetaSchemaMap(schemaMap: unknown): unknown {
  if (!isRecord(schemaMap)) return stripMetaSchema(schemaMap);
  return Object.fromEntries(
    Object.entries(schemaMap).map(([key, value]) => [key, stripMetaSchema(value)]),
  );
}

function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripMetaSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripMetaSchemaMap(value);
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = stripMetaSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const entries = value as unknown[];
  const scalar = entries.find(
    (entry): entry is string => typeof entry === "string" && entry !== "null",
  );
  return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (
      key === "enum" &&
      Array.isArray(value) &&
      !value.every((entry) => typeof entry === "string")
    ) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

function toolOutputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return String(output ?? "");
  const rec = output as Record<string, unknown>;
  if (rec.type === "text" && typeof rec.value === "string") return rec.value;
  if (rec.type === "content" && Array.isArray(rec.value)) {
    return rec.value
      .map((item: unknown) => {
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (rec.type === "json") return JSON.stringify(rec.value ?? null);
  if (rec.type === "execution-denied") {
    return rec.reason ? `Tool execution denied: ${rec.reason}` : "Tool execution denied";
  }
  if (rec.type === "error-text" && typeof rec.value === "string") return rec.value;
  if (rec.type === "error-json") return JSON.stringify(rec.value ?? null);
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function convertPromptToContents(
  prompt: LanguageModelV3Prompt,
  modelId: string,
  runtimeModel: string,
): { systemInstruction?: string; contents: GeminiContent[] } {
  const contents: GeminiContent[] = [];
  const systemParts: string[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }

    if (message.role === "user") {
      const parts: GeminiPart[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ text: sanitizeText(part.text) });
        } else if (part.type === "file") {
          const img = parseImageData(part.data as string | Uint8Array, part.mediaType);
          if (img) {
            parts.push({ inlineData: img });
          }
        }
      }
      appendTurn(contents, GeminiRole.User, parts);
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text && part.text.trim()) {
            parts.push({ text: sanitizeText(part.text) });
          }
        } else if (part.type === "reasoning") {
          if (part.text && part.text.trim()) {
            const thoughtSignature = thoughtSignatureFromMeta(part);
            parts.push({
              thought: true,
              text: sanitizeText(part.text),
              ...(thoughtSignature ? { thoughtSignature } : {}),
            });
          }
        } else if (part.type === "tool-call") {
          const args = parseToolCallInput(part.input);
          const callId = toolCallIdNeeded(modelId, runtimeModel)
            ? sanitizeToolCallId(part.toolCallId, part.toolName)
            : part.toolCallId;
          const thoughtSignature =
            thoughtSignatureFromMeta(part) ||
            SKIP_THOUGHT_SIGNATURE;
          parts.push({
            functionCall: {
              name: part.toolName,
              args,
              ...(callId ? { id: callId } : {}),
            },
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
        } else if (part.type === "tool-result") {
          // If assistant turn had parts before tool result, append assistant turn
          if (parts.length > 0) {
            appendTurn(contents, GeminiRole.Model, parts.splice(0));
          }
          const text = toolOutputToText(part.output);
          const rawId = part.toolCallId || "";
          const sanitizedId = toolCallIdNeeded(modelId, runtimeModel)
            ? sanitizeToolCallId(rawId, part.toolName)
            : rawId;
          const respPart: GeminiFunctionResponsePart = {
            functionResponse: {
              name: part.toolName || "tool",
              response: { output: text },
              ...(sanitizedId ? { id: sanitizedId } : {}),
            },
          };
          appendTurn(contents, GeminiRole.User, [respPart]);
        }
      }
      if (parts.length > 0) {
        appendTurn(contents, GeminiRole.Model, parts);
      }
      continue;
    }

    if (message.role === "tool") {
      const toolParts: GeminiPart[] = [];
      for (const part of message.content) {
        if (part.type === "tool-result") {
          const text = toolOutputToText(part.output);
          const rawId = part.toolCallId || "";
          const sanitizedId = toolCallIdNeeded(modelId, runtimeModel)
            ? sanitizeToolCallId(rawId, part.toolName)
            : rawId;
          toolParts.push({
            functionResponse: {
              name: part.toolName || "tool",
              response: { output: text },
              ...(sanitizedId ? { id: sanitizedId } : {}),
            },
          });
        }
      }
      if (toolParts.length > 0) {
        appendTurn(contents, GeminiRole.User, toolParts);
      }
    }
  }

  // Gemini requires the first turn to be from 'user'.
  if (contents.length > 0 && contents[0]?.role === GeminiRole.Model) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Hello" }],
    });
  }

  return {
    systemInstruction: systemParts.join("\n\n") || undefined,
    contents,
  };
}

// Tool schemas are static config that gets re-sent on every turn of a
// conversation; cache the (fairly expensive) dereference/strip/normalize
// pipeline per schema object so repeat turns don't redo the same work.
// Keyed by object identity (WeakMap), so entries disappear once the caller
// stops referencing that schema — no manual eviction needed.
const jsonSchemaCache = new WeakMap<object, Record<string, unknown>>();
const legacySchemaCache = new WeakMap<object, Record<string, unknown>>();

function processToolSchema(inputSchema: unknown, useLegacyParameters: boolean): Record<string, unknown> | undefined {
  const cache = useLegacyParameters ? legacySchemaCache : jsonSchemaCache;
  const cacheable = isRecord(inputSchema);
  if (cacheable) {
    const cached = cache.get(inputSchema);
    if (cached) return cached;
  }

  const dereferenced = dereferenceSchema(inputSchema);
  if (dereferenced.issues.length > 0) {
    return undefined;
  }

  const rootObject = ensureRootObjectSchema(dereferenced.schema);
  const stripped = stripMetaSchema(rootObject);
  const schema = (
    useLegacyParameters ? normalizeCustomToolSchema(stripped) : stripped
  ) as Record<string, unknown>;

  if (cacheable) cache.set(inputSchema, schema);
  return schema;
}

export function convertToolsToGemini(
  tools: LanguageModelV3CallOptions["tools"],
  useLegacyParameters = false,
): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: GeminiFunctionDeclaration[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const schema = processToolSchema(tool.inputSchema, useLegacyParameters);
    if (!schema) continue;

    functionDeclarations.push({
      name: tool.name,
      description: tool.description,
      ...(useLegacyParameters
        ? { parameters: schema }
        : { parametersJsonSchema: schema }),
    });
  }

  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

/**
 * The CLI omits toolConfig for implicit auto tool choice. Only explicit choices
 * require a function-calling mode on the wire.
 */
function toolConfigFor(
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): NonNullable<GeminiRequestBody["toolConfig"]> | undefined {
  switch (toolChoice?.type) {
    case "none":
      return { functionCallingConfig: { mode: GeminiToolCallingMode.None } };
    case "required":
      return { functionCallingConfig: { mode: GeminiToolCallingMode.Any } };
    case "tool":
      return {
        functionCallingConfig: {
          mode: GeminiToolCallingMode.Any,
          allowedFunctionNames: [toolChoice.toolName],
        },
      };
    default:
      return undefined;
  }
}

/**
 * Call options the Antigravity wire format has nowhere to put. Surfacing them
 * as warnings is how the AI SDK expects a provider to report silent drops.
 */
export function unsupportedSettingWarnings(
  callOptions: LanguageModelV3CallOptions,
): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  const unsupported = (feature: string, details: string) =>
    warnings.push({ type: "unsupported", feature, details });

  if (callOptions.seed !== undefined) {
    unsupported("seed", "Antigravity does not accept a sampling seed; output is not reproducible.");
  }
  if (callOptions.presencePenalty !== undefined) {
    unsupported("presencePenalty", "Antigravity does not accept presence penalties.");
  }
  if (callOptions.frequencyPenalty !== undefined) {
    unsupported("frequencyPenalty", "Antigravity does not accept frequency penalties.");
  }
  if (callOptions.responseFormat && callOptions.responseFormat.type !== "text") {
    unsupported(
      "responseFormat",
      "Structured output is not supported; request JSON in the prompt or use a tool instead.",
    );
  }
  return warnings;
}

export function buildAntigravityRequestBody(opts: {
  modelId: string;
  runtimeModel: string;
  projectId: string;
  callOptions: LanguageModelV3CallOptions;
  reasoningEffort?: string;
  sessionId?: string;
}): AntigravityGenerateRequest {
  const { modelId, runtimeModel, projectId, callOptions, reasoningEffort, sessionId } = opts;
  const isClaude = runtimeModel.startsWith("claude-") || modelId.startsWith("claude-");
  const isGptOss = runtimeModel.startsWith("gpt-oss-") || modelId.startsWith("gpt-oss-");
  const useLegacy = isClaude || isGptOss;

  const { systemInstruction, contents } = convertPromptToContents(
    callOptions.prompt,
    modelId,
    runtimeModel,
  );

  const generationConfig: GeminiGenerationConfig = {
    maxOutputTokens: getMaxOutputTokens(runtimeModel, callOptions.maxOutputTokens),
    temperature: callOptions.temperature,
    topP: callOptions.topP,
    ...(callOptions.topK !== undefined ? { topK: callOptions.topK } : {}),
    ...(callOptions.stopSequences?.length
      ? { stopSequences: callOptions.stopSequences }
      : {}),
  };

  const thinkingWire = getThinkingConfig(runtimeModel, reasoningEffort);
  if (thinkingWire) {
    generationConfig.thinkingConfig = {
      includeThoughts: thinkingWire.includeThoughts,
      thinkingBudget: thinkingWire.thinkingBudget,
    };
  }

  const baseInstruction = systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;
  const systemText = `${baseInstruction}\n\n${AGENT_EFFICIENCY_INSTRUCTION}`;

  const request: GeminiRequestBody = {
    contents,
    systemInstruction: {
      role: GeminiRole.User,
      parts: [{ text: systemText }],
    },
    generationConfig,
  };

  const geminiTools = convertToolsToGemini(callOptions.tools, useLegacy);
  if (geminiTools) {
    request.tools = geminiTools;
  }
  const toolConfig = toolConfigFor(callOptions.toolChoice);
  if (toolConfig) {
    request.toolConfig = toolConfig;
  }

  const envelope = antigravityRequestEnvelope(runtimeModel, isClaude, {
    sessionId,
    prompt: callOptions.prompt,
    step: Math.max(1, contents.length),
    lastStepIndex: Math.max(0, contents.length - 1),
    requestIndex: callOptions.prompt.filter(
      (message) => message.role === "assistant",
    ).length,
    isNonGemini: isClaude || isGptOss,
  });
  request.sessionId = envelope.sessionId;
  request.labels = envelope.labels;

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}
