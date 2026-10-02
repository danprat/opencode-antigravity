declare const plugin: {
  readonly id: string;
  readonly setup: (context: any) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
  readonly server: unknown;
};
export default plugin;
export declare const AntigravityPluginV2: typeof plugin;
