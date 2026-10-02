/**
 * Runtime duck-type boundary for the OpenCode 2.0 plugin — not host conformance.
 *
 * Only the methods and fields this plugin calls or publishes. Extra host
 * fields are ignored at runtime. This module must not import `@opencode/plugin`
 * or `@opencode-ai/plugin`: pinning a host plugin SDK would force a plugin bump
 * on every OpenCode release.
 *
 * Effect `Schema` brands (Provider.ID, Model.ID, …) are modelled as plain
 * `string`; brands are compile-time only and erase at runtime.
 */

// ── Registration primitives ──

export type Registration = {
  readonly dispose: () => Promise<void>;
};

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>;

export type ModelHookOptions = {
  /** Limits the hook to one provider; the host skips events for any other. */
  readonly providerID?: string;
};

export type ModelHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never,
) => Promise<Registration>;

export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;

// ── Provider inventory ──

export type ProviderInfo = {
  id: string;
  name: string;
  /** `"aisdk:<pkg>"` selects the AI SDK path; a bare specifier selects native. */
  package: string;
  activation: "auto" | "enabled" | "disabled";
  integrationID?: string;
};

export type ModelVariantInfo = {
  id: string;
  settings?: Record<string, unknown>;
};

export type CatalogModelInfo = {
  id: string;
  /** Wire id sent to the provider. Lets one backend model back several entries. */
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: ModelVariantInfo[];
  time: { released: number };
  cost: never[];
  status: "active";
  enabled: true;
  limit: { context: number; output: number };
  settings?: Record<string, unknown>;
};

export type ConnectionInfo = { type: string; id?: string; [key: string]: unknown };

/**
 * Inventory writer this plugin uses (`editor.add` only).
 * The host editor is a superset; unused methods are not part of this boundary.
 */
export type ProviderEditor = {
  add(input: {
    info: ProviderInfo;
    models: readonly CatalogModelInfo[];
    sourceConnection?: ConnectionInfo;
  }): void;
};

export type ProviderDomain = {
  readonly transform: Transform<ProviderEditor>;
  readonly reload: () => Promise<void>;
};

// ── Integration ──

export type IntegrationTextPrompt = {
  type: "text";
  key: string;
  message: string;
  placeholder?: string;
};

export type IntegrationOAuthMethod = {
  id: string;
  type: "oauth";
  label: string;
};

export type IntegrationKeyMethod = { type: "key"; label?: string; prompts?: IntegrationTextPrompt[] };
export type IntegrationEnvMethod = { type: "env"; names: string[] };
export type IntegrationMethod = IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod;

export type CredentialOAuth = {
  type: "oauth";
  methodID: string;
  refresh: string;
  access: string;
  expires: number;
  metadata?: Record<string, unknown>;
};

export type CredentialKey = {
  type: "key";
  key: string;
  metadata?: Record<string, unknown>;
};

export type CredentialValue = CredentialOAuth | CredentialKey;

export type IntegrationOAuthAuthorization = {
  readonly url: string;
  readonly instructions: string;
  readonly expiresAt?: number;
} & (
  | { readonly mode: "auto"; readonly callback: Promise<CredentialOAuth> }
  | { readonly mode: "code"; readonly callback: (code: string) => Promise<CredentialOAuth> }
);

export type IntegrationOAuthMethodRegistration = {
  readonly integrationID: string;
  readonly method: IntegrationOAuthMethod;
  readonly authorize: (answer?: Record<string, string>) => Promise<IntegrationOAuthAuthorization>;
  readonly refresh?: (credential: CredentialOAuth) => Promise<CredentialOAuth>;
  readonly label?: (credential: CredentialOAuth) => string | undefined;
};

export type IntegrationMethodRegistration =
  | IntegrationOAuthMethodRegistration
  | { readonly integrationID: string; readonly method: IntegrationKeyMethod }
  | { readonly integrationID: string; readonly method: IntegrationEnvMethod };

export type IntegrationRef = { id: string; name: string };

export type IntegrationDraft = {
  update(id: string, update: (integration: IntegrationRef) => void): void;
  readonly method: {
    update(input: IntegrationMethodRegistration): void;
  };
};

export type IntegrationDomain = {
  readonly transform: Transform<IntegrationDraft>;
  readonly reload: () => Promise<void>;
  readonly connection: {
    readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>;
    readonly resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>;
  };
};

// ── AI SDK ──

/** Fields this plugin reads from the host model object. */
export type HostModelRef = {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
};

export type AISDKHooks = {
  sdk: {
    readonly model: HostModelRef;
    readonly package: string;
    readonly options: Record<string, unknown>;
    sdk?: unknown;
  };
  language: {
    readonly model: HostModelRef;
    readonly sdk: unknown;
    readonly options: Record<string, unknown>;
    language?: unknown;
  };
};

export type AISDKDomain = { readonly hook: Hooks<AISDKHooks> };

// ── Tools ──

export type ToolExecutionContext = {
  readonly sessionID?: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly directory?: string;
  readonly abort?: AbortSignal;
  readonly signal?: AbortSignal;
  readonly progress?: (update: Record<string, unknown>) => Promise<void>;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly options?: { namespace?: string; codemode?: boolean };
  readonly execute: (input: any, context: ToolExecutionContext) => Promise<unknown>;
};

export type ToolDraft = {
  add(tool: ToolDefinition): void;
  get?(id: string): (ToolDefinition & { readonly id?: string }) | undefined;
  list?(): readonly (ToolDefinition & { readonly id: string })[];
};

export type ToolDomain = {
  readonly transform: Transform<ToolDraft>;
  readonly reload: () => Promise<void>;
};

// ── Commands ──

export type CommandInvocation = {
  readonly sessionID: string;
  readonly prompt: { text?: string; [key: string]: unknown };
  readonly delivery: "steer" | "queue";
};

export type CommandDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: CommandInvocation) => Promise<void>;
};

export type CommandDraft = {
  add(definition: CommandDefinition): void;
};

export type CommandDomain = {
  readonly transform: Transform<CommandDraft>;
  readonly reload: () => Promise<void>;
};

// ── Session ──

export type SessionModel = { providerID: string; id: string; variant?: string };

export type SessionContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: SessionModel;
  system: Array<unknown>;
  messages: Array<unknown>;
  tools: Record<string, unknown>;
  options?: Record<string, unknown>;
};

export type SessionModelRequest = {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: SessionModel;
  readonly kind: "primary" | "compaction" | "title" | "generate";
  baseURL?: string;
  headers: Record<string, string>;
};

export type SessionHooks = {
  readonly context: SessionContext;
  readonly compaction: SessionContext;
  readonly generate: SessionContext;
  readonly title: SessionContext;
  readonly "model.request": SessionModelRequest;
};

export type SessionInfo = {
  readonly id: string;
  readonly location: { readonly directory: string };
};

export type SessionDomain = {
  readonly hook: ModelHooks<SessionHooks>;
  readonly get: (input: { sessionID: string }) => Promise<SessionInfo>;
  readonly prompt?: (input: {
    sessionID: string;
    text: string;
    delivery?: "steer" | "queue";
  }) => Promise<unknown>;
};

// ── Events ──

export type EventDomain = {
  readonly subscribe: (...args: Array<unknown>) => AsyncIterable<{ type?: string; [key: string]: unknown }>;
};

// ── Plugin ──

export type PluginLocation = {
  readonly directory: string;
};

export type PluginContext = {
  readonly aisdk: AISDKDomain;
  readonly event: EventDomain;
  readonly integration: IntegrationDomain;
  readonly provider: ProviderDomain;
  readonly session: SessionDomain;
  readonly tool: ToolDomain;
  readonly command?: CommandDomain;
  readonly location?: PluginLocation;
};

export type Cleanup = () => Promise<void> | void;

export type Plugin2 = {
  readonly id: string;
  readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void;
};
