import type { CommandDraft, PluginContext } from "./types.js";

/**
 * Slash commands for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `config`-registered `command` templates.
 *
 * Each command submits its tool prompt into the session; the model then calls
 * the matching tool (`generate_image`, `antigravity_usage`,
 * `antigravity_models`) and shows the result.
 */
export function registerAntigravityCommands(draft: CommandDraft, ctx: PluginContext): void {
  if (typeof ctx.session.prompt !== "function") return;

  const prompt = ctx.session.prompt.bind(ctx.session);
  const submit = (text: string) => async ({ sessionID }: { sessionID: string }) => {
    await prompt({ sessionID, text });
  };

  draft.add({
    name: "antigravity-usage",
    description: "Show Antigravity shared quota pools",
    execute: submit("Call the antigravity_usage tool and show the result to the user. Do not add extra commentary."),
  });
  draft.add({
    name: "antigravity-models",
    description: "List Antigravity runtime models and remaining quota",
    execute: submit(
      "Call the antigravity_models tool and show the result to the user. Do not add extra commentary.",
    ),
  });
  draft.add({
    name: "antigravity-image",
    description: "Generate an image via Antigravity",
    execute: submit(
      "Call the generate_image tool with the user's remaining prompt as the image description. If they specified a ratio or path, pass those through.",
    ),
  });
}
