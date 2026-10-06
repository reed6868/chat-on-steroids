import type { ChatgptPlanStatus } from '../shared/types.js';
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature, type JsonWebKey as CryptoJsonWebKey } from 'node:crypto';
import { getSecret, setSecret, clearSecret } from './secrets.js';

const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const JWKS_URL = `${AUTH_ORIGIN}/.well-known/jwks.json`;
const OPENID_CONFIGURATION_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`;

export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct'
] as const;

const HOST_ID_KEY = 'chatgptPlanHostId' as const;
const CREDENTIAL_KEY = 'chatgptPlanOAuth' as const;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface ChatgptPlanCredential {
  issuer: string;
  subject: string;
  email: string | null;
  clientId: string;
  hostId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  savedAt: number;
  expiresAt: number;
}

export interface ChatgptPlanAuthStore {
  readHostId(): Promise<string | null>;
  writeHostId(value: string): Promise<void>;
  readCredential(): Promise<ChatgptPlanCredential | null>;
  writeCredential(value: ChatgptPlanCredential | null): Promise<void>;
}

export interface ValidatedIdToken {
  issuer: string;
  subject: string;
  email: string | null;
}

export interface ChatgptPlanAuthorizationAttempt {
  url: URL;
  state: string;
  nonce: string;
  verifier: string;
  hostId: string;
  redirectUri: string;
  clientId: string;
  expectedSubject: string | null;
  registration: boolean;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface IdTokenValidationOptions {
  clientId: string;
  nonce?: string;
}

interface ChatgptPlanAuthOptions {
  store?: ChatgptPlanAuthStore;
  fetch?: typeof fetch;
  validateIdToken?: (token: string, options: IdTokenValidationOptions) => Promise<ValidatedIdToken>;
  now?: () => number;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`ChatGPT Plan OAuth returned no ${name}`);
  return value;
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ChatGPT Plan OAuth returned an invalid token response');
  const row = value as Record<string, unknown>;
  const expiresIn = Number(row.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('ChatGPT Plan OAuth returned an invalid token lifetime');
  return {
    access_token: requiredString(row.access_token, 'access token'),
    ...(typeof row.refresh_token === 'string' && row.refresh_token ? { refresh_token: row.refresh_token } : {}),
    id_token: requiredString(row.id_token, 'ID token'),
    token_type: requiredString(row.token_type, 'token type'),
    expires_in: expiresIn,
    ...(typeof row.scope === 'string' ? { scope: row.scope } : {})
  };
}

function parseScopes(value: string | undefined, fallback: readonly string[]): string[] {
  const scopes = (value ?? '').split(/\s+/).map(scope => scope.trim()).filter(Boolean);
  return scopes.length ? [...new Set(scopes)] : [...fallback];
}

function hasRequiredScopes(scopes: readonly string[]): boolean {
  const set = new Set(scopes);
  return CHATGPT_PLAN_SCOPES.every(scope => set.has(scope));
}

class SecureChatgptPlanAuthStore implements ChatgptPlanAuthStore {
  async readHostId(): Promise<string | null> {
    return getSecret(HOST_ID_KEY);
  }

  async writeHostId(value: string): Promise<void> {
    await setSecret(HOST_ID_KEY, value);
  }

  async readCredential(): Promise<ChatgptPlanCredential | null> {
    const raw = await getSecret(CREDENTIAL_KEY);
    if (!raw || raw.length > 131072) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const row = parsed as Partial<ChatgptPlanCredential>;
      if (
        row.issuer !== AUTH_ORIGIN ||
        typeof row.subject !== 'string' ||
        typeof row.clientId !== 'string' ||
        typeof row.hostId !== 'string' ||
        typeof row.idToken !== 'string' ||
        typeof row.accessToken !== 'string' ||
        typeof row.refreshToken !== 'string' ||
        typeof row.tokenType !== 'string' ||
        !Array.isArray(row.scopes) ||
        !row.scopes.every(scope => typeof scope === 'string') ||
        typeof row.savedAt !== 'number' ||
        typeof row.expiresAt !== 'number'
      ) return null;
      return {
        issuer: row.issuer,
        subject: row.subject,
        email: typeof row.email === 'string' ? row.email : null,
        clientId: row.clientId,
        hostId: row.hostId,
        idToken: row.idToken,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        tokenType: row.tokenType,
        scopes: [...row.scopes],
        savedAt: row.savedAt,
        expiresAt: row.expiresAt
      };
    } catch {
      return null;
    }
  }

  async writeCredential(value: ChatgptPlanCredential | null): Promise<void> {
    if (!value) {
      await clearSecret(CREDENTIAL_KEY);
      return;
    }
    await setSecret(CREDENTIAL_KEY, JSON.stringify(value));
  }
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ChatGPT Plan OAuth returned an invalid ID token');
  return parsed as Record<string, unknown>;
}

async function defaultValidateIdToken(
  token: string,
  options: IdTokenValidationOptions,
  fetcher: typeof fetch,
  now: () => number
): Promise<ValidatedIdToken> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT Plan OAuth returned an invalid ID token');
  const header = decodeJwtPart(parts[0]!);
  const claims = decodeJwtPart(parts[1]!);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('ChatGPT Plan OAuth returned an unsupported ID token signature');
  }

  const jwksResponse = await fetcher(JWKS_URL, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json' }
  });
  if (!jwksResponse.ok) throw new Error(`ChatGPT Plan OAuth signing keys could not be loaded (${jwksResponse.status})`);
  const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('ChatGPT Plan OAuth signing key was not found');
  const publicKey = createPublicKey({ key: jwk as CryptoJsonWebKey, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, 'base64url');
  if (!verifySignature('RSA-SHA256', signed, publicKey, signature)) {
    throw new Error('ChatGPT Plan OAuth ID token signature is invalid');
  }

  if (claims.iss !== AUTH_ORIGIN) throw new Error('ChatGPT Plan OAuth ID token issuer is invalid');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(options.clientId)) throw new Error('ChatGPT Plan OAuth ID token audience is invalid');
  if (options.nonce && claims.nonce !== options.nonce) throw new Error('ChatGPT Plan OAuth ID token nonce is invalid');
  const nowSeconds = Math.floor(now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new Error('ChatGPT Plan OAuth ID token is expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 60) throw new Error('ChatGPT Plan OAuth ID token is not active');
  const subject = requiredString(claims.sub, 'subject');
  return {
    issuer: AUTH_ORIGIN,
    subject,
    email: typeof claims.email === 'string' ? claims.email : null
  };
}

export class ChatgptPlanAuth {
  private readonly store: ChatgptPlanAuthStore;
  private readonly fetcher: typeof fetch;
  private readonly validator: (token: string, options: IdTokenValidationOptions) => Promise<ValidatedIdToken>;
  private readonly now: () => number;
  private refreshFlight: Promise<ChatgptPlanCredential> | null = null;

  constructor(options: ChatgptPlanAuthOptions = {}) {
    this.store = options.store ?? new SecureChatgptPlanAuthStore();
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.validator = options.validateIdToken ??
      ((token, validation) => defaultValidateIdToken(token, validation, this.fetcher, this.now));
  }

  async status(): Promise<ChatgptPlanStatus> {
    const credential = await this.store.readCredential();
    return credential
      ? {
          signedIn: true,
          planEnabled: hasRequiredScopes(credential.scopes),
          email: credential.email,
          expiresAt: credential.expiresAt
        }
      : { signedIn: false, planEnabled: false, email: null, expiresAt: null };
  }

  async createAuthorizationAttempt(redirectUri: string): Promise<ChatgptPlanAuthorizationAttempt> {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback') {
      throw new Error('ChatGPT Plan OAuth requires a loopback 127.0.0.1 callback');
    }
    let hostId = await this.store.readHostId();
    if (!hostId) {
      hostId = `urn:uuid:${randomUUID()}`;
      await this.store.writeHostId(hostId);
    }
    const saved = await this.store.readCredential();
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const verifier = base64url(randomBytes(48));
    const registration = !saved;
    const clientId = saved?.clientId ?? 'dynamic_agent_client';
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', CHATGPT_PLAN_SCOPES.join(' '));
    url.searchParams.set('resource', CHATGPT_PLAN_RESOURCE);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('ext_agent_host_id', hostId);
    if (saved) {
      url.searchParams.set('id_token_hint', saved.idToken);
      if (saved.email) url.searchParams.set('login_hint', saved.email);
    } else {
      url.searchParams.set('agent_name_hint', 'Chat On Steroids');
    }
    return {
      url,
      state,
      nonce,
      verifier,
      hostId,
      redirectUri,
      clientId,
      expectedSubject: saved?.subject ?? null,
      registration
    };
  }

  async completeAuthorizationAttempt(
    params: URLSearchParams,
    attempt: ChatgptPlanAuthorizationAttempt
  ): Promise<ChatgptPlanCredential> {
    const state = params.get('state') ?? '';
    if (!state || !constantTimeEqual(state, attempt.state)) throw new Error('ChatGPT Plan OAuth callback state is invalid');
    if (params.get('error')) throw new Error('ChatGPT Plan sign-in was not completed');
    const code = requiredString(params.get('code'), 'authorization code');
    const callbackClientId = params.get('client_id');
    let clientId: string;
    if (attempt.registration) {
      clientId = requiredString(callbackClientId, 'issued client id');
      if (clientId === 'dynamic_agent_client') throw new Error('ChatGPT Plan registration returned no issued client id');
    } else {
      clientId = attempt.clientId;
      if (callbackClientId && callbackClientId !== clientId) {
        throw new Error('ChatGPT Plan OAuth callback changed the registered client id');
      }
    }
    const tokens = await this.exchange(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
      client_id: clientId,
      resource: CHATGPT_PLAN_RESOURCE
    }));
    const identity = await this.validator(tokens.id_token, { clientId, nonce: attempt.nonce });
    if (attempt.expectedSubject && identity.subject !== attempt.expectedSubject) {
      throw new Error('ChatGPT Plan reauthorization changed account identity');
    }
    const scopes = parseScopes(tokens.scope, CHATGPT_PLAN_SCOPES);
    if (!hasRequiredScopes(scopes)) throw new Error('ChatGPT Plan OAuth did not grant all required scopes');
    if (!tokens.refresh_token) throw new Error('ChatGPT Plan OAuth returned no refresh token');
    const now = this.now();
    const credential: ChatgptPlanCredential = {
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      clientId,
      hostId: attempt.hostId,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      scopes,
      savedAt: now,
      expiresAt: now + tokens.expires_in * 1000
    };
    await this.store.writeCredential(credential);
    return credential;
  }

  async accessToken(): Promise<string> {
    const credential = await this.store.readCredential();
    if (!credential) throw new Error('Sign in with ChatGPT before using the Codex runtime');
    if (credential.expiresAt - this.now() > TOKEN_EXPIRY_SKEW_MS) return credential.accessToken;
    return (await this.refresh()).accessToken;
  }

  async signOut(): Promise<{ revoked: boolean }> {
    const credential = await this.store.readCredential();
    if (!credential) return { revoked: true };
    let revoked = false;
    try {
      const discovery = await this.fetcher(OPENID_CONFIGURATION_URL, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json' }
      });
      if (!discovery.ok) throw new Error(`OpenAI OAuth discovery failed (${discovery.status})`);
      const metadata = await discovery.json() as { revocation_endpoint?: unknown };
      const endpoint = requiredString(metadata.revocation_endpoint, 'revocation endpoint');
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash) {
        throw new Error('OpenAI OAuth revocation endpoint is invalid');
      }
      const response = await this.fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          token: credential.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: credential.clientId
        })
      });
      if (!response.ok) throw new Error(`ChatGPT Plan OAuth revocation failed (${response.status})`);
      revoked = true;
    } catch {
      revoked = false;
    } finally {
      // Local sign-out is authoritative even when network revocation cannot be confirmed.
      await this.store.writeCredential(null);
    }
    return { revoked };
  }

  async signIn(
    open: (url: URL) => Promise<void>,
    timeoutMs = 180_000
  ): Promise<ChatgptPlanStatus> {
    const server = createServer({ maxHeaderSize: 8192 });
    let settle!: (params: URLSearchParams) => void;
    let fail!: (error: Error) => void;
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void callback.catch(() => undefined);
    const timer = setTimeout(() => {
      fail(new Error('ChatGPT Plan sign-in timed out'));
      server.closeAllConnections();
      server.close();
    }, timeoutMs);
    timer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start the ChatGPT Plan sign-in callback');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const attempt = await this.createAuthorizationAttempt(redirectUri);
      server.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        let url: URL;
        try {
          url = new URL(request.url ?? '/', redirectUri);
        } catch {
          response.writeHead(400).end('Invalid sign-in callback.');
          return;
        }
        const valid =
          request.method === 'GET' &&
          request.headers.host === `127.0.0.1:${address.port}` &&
          url.origin === new URL(redirectUri).origin &&
          url.pathname === '/auth/callback' &&
          (request.url?.length ?? 0) <= 8192 &&
          ['state', 'code', 'client_id', 'error'].every(key => url.searchParams.getAll(key).length <= 1) &&
          constantTimeEqual(url.searchParams.get('state') ?? '', attempt.state);
        if (!valid) {
          response.writeHead(400).end('Invalid sign-in callback.');
          return;
        }
        if (url.searchParams.get('error')) {
          response.writeHead(400).end('Sign-in was not completed. Return to Chat On Steroids.');
          fail(new Error('ChatGPT Plan sign-in was not completed'));
          return;
        }
        response.end('Authorization received. Return to Chat On Steroids.');
        server.close();
        settle(url.searchParams);
      });
      await open(attempt.url);
      const params = await callback;
      await this.completeAuthorizationAttempt(params, attempt);
      return this.status();
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    }
  }

  private async refresh(): Promise<ChatgptPlanCredential> {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = (async () => {
      const latest = await this.store.readCredential();
      if (!latest) throw new Error('Sign in with ChatGPT before using the Codex runtime');
      if (latest.expiresAt - this.now() > TOKEN_EXPIRY_SKEW_MS) return latest;
      const tokens = await this.exchange(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: latest.refreshToken,
        client_id: latest.clientId,
        resource: CHATGPT_PLAN_RESOURCE
      }));
      const identity = await this.validator(tokens.id_token, { clientId: latest.clientId });
      if (identity.subject !== latest.subject) throw new Error('ChatGPT Plan refresh changed account identity');
      const scopes = parseScopes(tokens.scope, latest.scopes);
      if (!hasRequiredScopes(scopes)) throw new Error('ChatGPT Plan refresh lost required scopes');
      const now = this.now();
      const refreshed: ChatgptPlanCredential = {
        ...latest,
        issuer: identity.issuer,
        email: identity.email,
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? latest.refreshToken,
        tokenType: tokens.token_type,
        scopes,
        savedAt: now,
        expiresAt: now + tokens.expires_in * 1000
      };
      await this.store.writeCredential(refreshed);
      return refreshed;
    })().finally(() => {
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }

  private async exchange(body: URLSearchParams): Promise<TokenResponse> {
    const response = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (!response.ok) throw new Error(`ChatGPT Plan OAuth token exchange failed (${response.status})`);
    return parseTokenResponse(await response.json());
  }
}

export const chatgptPlanAuth = new ChatgptPlanAuth();
