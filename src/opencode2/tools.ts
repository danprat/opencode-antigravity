import { generateAntigravityImage } from "../image/image.js";
import { fetchAccountUsage, formatModelsList, formatUsageSummary } from "../usage/usage.js";
import { safeError } from "../utils/security.js";
import type { ToolDefinition } from "./types.js";

export type AntigravityToolDeps = {
  /** Resolve a usable Antigravity access token (env, then active connection). */
  requireAccessToken: () => Promise<string>;
  /** Resolve the workspace directory image files are saved under. */
  resolveDirectory: (sessionID?: string) => Promise<string>;
};

async function requireToken(deps: AntigravityToolDeps): Promise<string> {
  const token = await deps.requireAccessToken();
  if (!token) {
    throw new Error("No Antigravity credentials. Run `/connect` and choose Antigravity.");
  }
  return token;
}

const IMAGE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", description: "Image description." },
    aspectRatio: { type: "string", description: "Aspect ratio, e.g. 1:1, 16:9, 4:3." },
    model: { type: "string", description: "Image model id. Default: gemini-3-pro-image." },
    path: { type: "string", description: "Project-relative file or directory to save the image." },
  },
  required: ["prompt"],
} as const;

const MODELS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    all: { type: "boolean", description: "Include tab/chat models normally hidden from the list." },
  },
} as const;

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/**
 * The three Antigravity tools, adapted to the OpenCode 2.0 tool surface:
 * JSON-Schema `input`, `{ output, content }` results.
 *
 * `generate_image` saves the file (same `.opencode/generated-images/`
 * default as V1) and returns the saved paths as text. Unlike V1 it does not
 * attach image parts to the tool result — the 2.0 model output is projected
 * from `content`, so the model reads the file back from disk when it needs
 * pixels.
 */
export function createAntigravityToolDefinitions(deps: AntigravityToolDeps): ToolDefinition[] {
  return [
    {
      name: "generate_image",
      description:
        "Generate an image via Antigravity using the signed-in Google account. Saves under .opencode/generated-images/ unless path is set.",
      input: IMAGE_INPUT_SCHEMA,
      output: { type: "string" },
      execute: async (
        input: {
          prompt: string;
          aspectRatio?: string;
          model?: string;
          path?: string;
        },
        context?: { sessionID?: string; signal?: AbortSignal; abort?: AbortSignal },
      ) => {
        const accessToken = await requireToken(deps);
        const cwd = await deps.resolveDirectory(context?.sessionID);
        const result = await generateAntigravityImage({
          accessToken,
          cwd,
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          model: input.model,
          path: input.path,
          signal: context?.signal ?? context?.abort,
        });
        const notes = result.text.join(" ").trim();
        const output = `Saved image to ${result.savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`;
        return {
          output,
          content: output,
          metadata: { model: result.model, savedPaths: result.savedPaths },
        };
      },
    },
    {
      name: "antigravity_usage",
      description:
        "Show Antigravity / Cloud Code Assist shared quota pools and reset times for the signed-in Google account.",
      input: EMPTY_INPUT_SCHEMA,
      output: { type: "string" },
      execute: async () => {
        try {
          const token = await requireToken(deps);
          const output = formatUsageSummary(await fetchAccountUsage(token));
          return { output, content: output };
        } catch (error) {
          throw new Error(safeError(error));
        }
      },
    },
    {
      name: "antigravity_models",
      description:
        "List Antigravity runtime models with remaining shared-pool quota. Set all=true to include tab/chat models.",
      input: MODELS_INPUT_SCHEMA,
      output: { type: "string" },
      execute: async (input: { all?: boolean }) => {
        try {
          const token = await requireToken(deps);
          const output = formatModelsList(await fetchAccountUsage(token), { all: input.all === true });
          return { output, content: output };
        } catch (error) {
          throw new Error(safeError(error));
        }
      },
    },
  ];
}
