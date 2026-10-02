import {
  generateAntigravityAuthParams,
  getAntigravityAccessTokenFromEnv,
  refreshAntigravityAccessToken,
} from "../auth/oauth.js";
import { ANTIGRAVITY_INTEGRATION_ID } from "./catalog.js";
import type {
  CredentialOAuth,
  CredentialValue,
  IntegrationDomain,
  IntegrationDraft,
} from "./types.js";

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for
 * the classic plugin's `auth` hook (`methods` + `loader`).
 *
 * The PKCE browser flow from `src/auth/oauth.ts` ports across unchanged:
 * 2.0 takes plain Promises for `authorize`/`refresh`.
 */

export const ANTIGRAVITY_OAUTH_METHOD_ID = "oauth";

/** Env vars that can supply an Antigravity access token without /connect. */
export const ANTIGRAVITY_ENV_NAMES = ["ANTIGRAVITY_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"];

/**
 * Browser (PKCE) login: opens Google sign-in, waits on the loopback callback
 * at `http://localhost:51121/oauth-callback`, then exchanges the code.
 */
async function authorizeOAuth() {
  const params = await generateAntigravityAuthParams();
  return {
    url: params.loginUrl,
    instructions: "Open this URL in a browser to sign in with your Google account",
    mode: "auto" as const,
    callback: params.waitForCallback().then(
      (result): CredentialOAuth => ({
        type: "oauth",
        methodID: ANTIGRAVITY_OAUTH_METHOD_ID,
        access: result.access,
        // `waitForCallback` always returns a refresh token (it throws
        // otherwise), so non-null here is safe.
        refresh: result.refresh as string,
        expires: result.expires ?? Date.now(),
        ...(result.projectId || result.email
          ? { metadata: { ...(result.projectId ? { projectId: result.projectId } : {}), ...(result.email ? { email: result.email } : {}) } }
          : {}),
      }),
    ),
  };
}

/**
 * Renew an expiring Google access token. The host calls this lazily when the
 * stored credential is close to expiry. Project/email metadata rides along so
 * the refreshed credential keeps seeding project-id checks downstream.
 */
async function refreshOAuth(credential: CredentialOAuth): Promise<CredentialOAuth> {
  const refreshed = await refreshAntigravityAccessToken(credential.refresh);
  return {
    type: "oauth",
    methodID: credential.methodID || ANTIGRAVITY_OAUTH_METHOD_ID,
    access: refreshed.access,
    refresh: refreshed.refresh ?? credential.refresh,
    expires: refreshed.expires ?? Date.now(),
    ...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
  };
}

/** Register the Antigravity integration and its connection methods. */
export function applyAntigravityIntegration(draft: IntegrationDraft): void {
  draft.update(ANTIGRAVITY_INTEGRATION_ID, (integration) => {
    integration.id = ANTIGRAVITY_INTEGRATION_ID;
    integration.name = "Antigravity";
  });

  draft.method.update({
    integrationID: ANTIGRAVITY_INTEGRATION_ID,
    method: {
      id: ANTIGRAVITY_OAUTH_METHOD_ID,
      type: "oauth",
      label: "Google account (Antigravity browser login)",
    },
    authorize: authorizeOAuth,
    refresh: refreshOAuth,
  });

  draft.method.update({
    integrationID: ANTIGRAVITY_INTEGRATION_ID,
    method: { type: "key", label: "Access Token (ya29... / OAuth token)" },
  });

  draft.method.update({
    integrationID: ANTIGRAVITY_INTEGRATION_ID,
    method: { type: "env", names: ANTIGRAVITY_ENV_NAMES },
  });
}

/**
 * Turn a stored credential into an Antigravity access token.
 *
 * OAuth credentials hold the access token directly (the host refreshes them
 * via `refresh` above). A `key` credential is the raw `ya29…` token, used
 * as-is — mirroring the classic plugin's API-token method.
 */
export async function accessTokenFromCredential(
  credential: CredentialValue | undefined,
): Promise<string | undefined> {
  if (!credential) return undefined;

  if (credential.type === "oauth") {
    if (credential.access) return credential.access;
    return undefined;
  }

  if (credential.type === "key") {
    return credential.key?.trim() || undefined;
  }

  return undefined;
}

/**
 * Resolve the active Antigravity connection into an access token, if any.
 *
 * Env override wins (same lookup order as V1: `OPENCODE_ANTIGRAVITY_*`, then
 * `ANTIGRAVITY_*`, then `GOOGLE_ACCESS_TOKEN`), so scripts and CI can bypass
 * /connect without touching the credential store.
 */
export async function resolveAntigravityAccessToken(
  integration: IntegrationDomain,
): Promise<string | undefined> {
  const env = getAntigravityAccessTokenFromEnv();
  if (env) return env;
  try {
    const connection = await integration.connection.active(ANTIGRAVITY_INTEGRATION_ID);
    if (!connection) return undefined;
    return await accessTokenFromCredential(await integration.connection.resolve(connection));
  } catch {
    return undefined;
  }
}
