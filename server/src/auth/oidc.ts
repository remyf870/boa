// Microsoft Entra ID sign-in: OIDC authorization-code flow with PKCE (A.8.5).
// The app inherits Massy's MFA, conditional access and joiner/mover/leaver
// process (plan §2). No passwords exist in this app outside break-glass.
import * as oidc from 'openid-client';
import type { Config } from '../config.js';

export interface OidcFlowState {
  verifier: string;
  state: string;
  nonce: string;
}

let cached: oidc.Configuration | undefined;

export async function getOidcConfiguration(config: Config): Promise<oidc.Configuration> {
  if (cached) return cached;
  const issuer = new URL(`https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/v2.0`);
  cached = await oidc.discovery(issuer, config.ENTRA_CLIENT_ID!, config.ENTRA_CLIENT_SECRET!);
  return cached;
}

export async function beginLogin(config: Config): Promise<{ redirectUrl: string; flow: OidcFlowState }> {
  const oc = await getOidcConfiguration(config);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(oc, {
    redirect_uri: config.OIDC_REDIRECT_URI!,
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { redirectUrl: url.href, flow: { verifier, state, nonce } };
}

export interface OidcIdentity {
  entraObjectId: string;
  email: string;
  displayName: string;
}

export async function completeLogin(
  config: Config,
  callbackUrl: URL,
  flow: OidcFlowState,
): Promise<OidcIdentity> {
  const oc = await getOidcConfiguration(config);
  const tokens = await oidc.authorizationCodeGrant(oc, callbackUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('Entra ID returned no ID token claims');
  const oid = claims['oid'] ?? claims.sub;
  const email = (claims['preferred_username'] ?? claims['email']) as string | undefined;
  const name = (claims['name'] as string | undefined) ?? email;
  if (!oid || !email || !name) {
    throw new Error('Entra ID claims missing oid/preferred_username/name');
  }
  return { entraObjectId: String(oid), email, displayName: name };
}
