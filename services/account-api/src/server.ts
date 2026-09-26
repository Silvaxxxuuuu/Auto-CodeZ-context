import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from 'better-auth/node';
import { loadEnvironment } from './env.js';
import { Database } from './db.js';
import { MagicLinkEmailSender } from './email.js';
import { createBetterAuth } from './auth.js';
import { DesktopAuthFlowService } from './desktop-auth-flow.js';
import { DesktopSessionService } from './desktop-session.js';
import { DeviceRegistryService } from './device-registry.js';
import { DescopeSessionVerifier } from './descope-session-verifier.js';
import {
  bearerToken,
  requestHeaders,
  requireObject,
  requireProvider,
  requireString,
  sendError,
} from './http.js';
import type { BrowserUser } from './models.js';

const environment = loadEnvironment();
const database = new Database(environment);
const email = new MagicLinkEmailSender(environment);
const auth = createBetterAuth(environment, database, email);
const flows = new DesktopAuthFlowService(database);
const sessions = new DesktopSessionService(database, environment);
const deviceAccessVerifier = environment.descopeProjectId
  ? new DescopeSessionVerifier(environment.descopeProjectId, {
      baseUrl: environment.descopeBaseUrl,
    })
  : undefined;
const devices = new DeviceRegistryService(database, environment, Date.now, deviceAccessVerifier);
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (request.path.startsWith('/v1/auth/') || request.path.startsWith('/desktop/')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
  }
  if (request.path.startsWith('/desktop/passkey')) {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  }
  next();
});

app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json({ limit: '128kb' }));
app.use('/assets', express.static(path.join(__dirname, 'public'), {
  immutable: true,
  maxAge: '1h',
  fallthrough: false,
}));

function absolute(pathname: string): string {
  return new URL(pathname, environment.publicUrl).toString();
}

function desktopRedirect(pathname: string, params: Record<string, string>): string {
  const url = new URL('autocodez://auth/' + pathname);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function safeText(value: string): string {
  return value.replace(/[&<>]/g, '');
}

function errorPage(message: string): string {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto CodeZ</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a0e;color:#dce3eb;font:14px/1.6 system-ui,sans-serif}.box{max-width:440px;padding:32px;border:1px solid #252b34;border-radius:14px;background:#0e1218;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#8792a2;margin:0}</style></head><body><main class="box"><h1>Auto CodeZ</h1><p>' + safeText(message) + '</p></main></body></html>';
}

async function browserUser(request: Request): Promise<BrowserUser> {
  const session = await auth.api.getSession({
    headers: requestHeaders(request),
  });
  if (!session?.user?.id || !session.user.email) throw new Error('invalid_grant');
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name || session.user.email.split('@')[0] || 'Auto CodeZ User',
    ...(session.user.image ? { image: session.user.image } : {}),
  };
}

async function browserFinish(
  request: Request,
  response: Response,
  kind: 'oauth' | 'magic_link' | 'passkey',
): Promise<void> {
  try {
    const flowId = requireString(request.query.flowId, 'flowId', 256);
    const user = await browserUser(request);
    const completed = await flows.finishBrowser({ flowId, kind, user });
    const route = kind === 'magic_link' ? 'magic-link' : kind;
    const secretName = kind === 'magic_link' ? 'token' : 'code';
    response.redirect(302, desktopRedirect(route, {
      flowId,
      [secretName]: completed.oneTimeToken,
      state: completed.state,
    }));
  } catch {
    response.status(400).type('html').send(
      errorPage('Não foi possível concluir a autenticação. Volte ao Auto CodeZ e tente novamente.'),
    );
  }
}

app.get('/healthz', async (_request, response) => {
  try {
    await database.query('SELECT 1');
    response.json({ ok: true });
  } catch {
    response.status(503).json({ ok: false });
  }
});

app.post('/v1/auth/configuration', (_request, response) => {
  const methods: Array<'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey'> = [];
  if (email.configured) methods.push('magic_link');
  if (environment.github) methods.push('github');
  if (environment.google) methods.push('google');
  if (environment.microsoft) methods.push('microsoft');
  methods.push('passkey');
  response.json({ methods });
});

app.post('/v1/auth/oauth/begin', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    const provider = requireProvider(body.provider);
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const state = requireString(body.state, 'state', 512);
    const nonce = requireString(body.nonce, 'nonce', 512);
    const codeChallenge = requireString(body.codeChallenge, 'codeChallenge', 512);
    if (body.codeChallengeMethod !== 'S256') throw new Error('codeChallengeMethod invalid.');

    const flow = await flows.begin({
      kind: 'oauth',
      deviceId,
      provider,
      state,
      nonce,
      codeChallenge,
    });

    response.json({
      authorizationUrl: absolute('/desktop/oauth/start?flowId=' + encodeURIComponent(flow.flowId)),
      flowId: flow.flowId,
      expiresAt: flow.expiresAt,
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/oauth/complete', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    const provider = requireProvider(body.provider);
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const result = await flows.exchange({
      kind: 'oauth',
      flowId: requireString(body.flowId, 'flowId', 256),
      provider,
      deviceId,
      oneTimeToken: requireString(body.code, 'code'),
      state: requireString(body.state, 'state', 512),
      nonce: requireString(body.nonce, 'nonce', 512),
      codeVerifier: requireString(body.codeVerifier, 'codeVerifier', 512),
    });

    response.json(await sessions.issue({
      user: result.user,
      provider: result.provider,
      deviceId,
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/magic-link/begin', async (request, response) => {
  try {
    if (!email.configured) throw new Error('Magic Link email transport is not configured.');
    const body = requireObject(request.body, 'body');
    const emailAddress = requireString(body.email, 'email', 254).toLowerCase();
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const state = requireString(body.state, 'state', 512);
    const codeChallenge = requireString(body.codeChallenge, 'codeChallenge', 512);
    if (body.codeChallengeMethod !== 'S256') throw new Error('codeChallengeMethod invalid.');

    const flow = await flows.begin({
      kind: 'magic_link',
      deviceId,
      state,
      codeChallenge,
      email: emailAddress,
    });

    const callbackURL = absolute(
      '/desktop/magic-link/finish?flowId=' + encodeURIComponent(flow.flowId),
    );

    await auth.api.signInMagicLink({
      headers: requestHeaders(request),
      body: {
        email: emailAddress,
        callbackURL,
        errorCallbackURL: callbackURL,
      },
    });

    response.json({
      flowId: flow.flowId,
      expiresAt: flow.expiresAt,
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/magic-link/complete', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const result = await flows.exchange({
      kind: 'magic_link',
      flowId: requireString(body.flowId, 'flowId', 256),
      deviceId,
      oneTimeToken: requireString(body.token, 'token'),
      state: requireString(body.state, 'state', 512),
      codeVerifier: requireString(body.codeVerifier, 'codeVerifier', 512),
    });

    response.json(await sessions.issue({
      user: result.user,
      provider: 'magic_link',
      deviceId,
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/passkey/begin', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const state = requireString(body.state, 'state', 512);
    const nonce = requireString(body.nonce, 'nonce', 512);
    const codeChallenge = requireString(body.codeChallenge, 'codeChallenge', 512);
    if (body.codeChallengeMethod !== 'S256') throw new Error('codeChallengeMethod invalid.');

    const flow = await flows.begin({
      kind: 'passkey',
      deviceId,
      state,
      nonce,
      codeChallenge,
    });

    response.json({
      authorizationUrl: absolute('/desktop/passkey?flowId=' + encodeURIComponent(flow.flowId)),
      flowId: flow.flowId,
      expiresAt: flow.expiresAt,
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/passkey/complete', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    const result = await flows.exchange({
      kind: 'passkey',
      flowId: requireString(body.flowId, 'flowId', 256),
      deviceId,
      oneTimeToken: requireString(body.code, 'code'),
      state: requireString(body.state, 'state', 512),
      nonce: requireString(body.nonce, 'nonce', 512),
      codeVerifier: requireString(body.codeVerifier, 'codeVerifier', 512),
    });

    response.json(await sessions.issue({
      user: result.user,
      provider: 'passkey',
      deviceId,
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/session/refresh', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    response.json(await sessions.refresh(
      requireString(body.refreshToken, 'refreshToken', 32_768),
      requireString(body.deviceId, 'deviceId', 256),
    ));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/auth/session/revoke', async (request, response) => {
  try {
    const body = requireObject(request.body, 'body');
    await sessions.revoke({
      sessionId: requireString(body.sessionId, 'sessionId', 256),
      deviceId: requireString(body.deviceId, 'deviceId', 256),
      ...(typeof body.refreshToken === 'string' && body.refreshToken.trim()
        ? { refreshToken: body.refreshToken.trim() }
        : {}),
    });
    response.status(204).end();
  } catch (error) {
    sendError(response, error);
  }
});

app.get('/desktop/oauth/start', async (request, response) => {
  try {
    const flowId = requireString(request.query.flowId, 'flowId', 256);
    const flow = await flows.get(flowId);
    if (flow.kind !== 'oauth') throw new Error('invalid_grant');
    if (flow.provider !== 'github' && flow.provider !== 'google' && flow.provider !== 'microsoft') {
      throw new Error('invalid_grant');
    }

    const callbackURL = absolute(
      '/desktop/oauth/finish?flowId=' + encodeURIComponent(flow.id),
    );

    const authResponse = await auth.api.signInSocial({
      headers: requestHeaders(request),
      body: {
        provider: flow.provider,
        callbackURL,
        errorCallbackURL: callbackURL,
        disableRedirect: true,
      },
      asResponse: true,
    });

    if (!authResponse.ok) throw new Error('oauth_url_unavailable');

    const payload = await authResponse.json() as { url?: unknown };
    if (typeof payload.url !== 'string' || !payload.url) throw new Error('oauth_url_unavailable');

    const getSetCookie = (authResponse.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === 'function'
      ? getSetCookie.call(authResponse.headers)
      : [];
    if (setCookies.length > 0) response.setHeader('Set-Cookie', setCookies);

    response.redirect(302, payload.url);
  } catch {
    response.status(400).type('html').send(
      errorPage('Não foi possível iniciar a autenticação. Volte ao Auto CodeZ e tente novamente.'),
    );
  }
});

app.get('/desktop/oauth/finish', (request, response) => {
  void browserFinish(request, response, 'oauth');
});

app.get('/desktop/magic-link/finish', (request, response) => {
  void browserFinish(request, response, 'magic_link');
});

app.get('/desktop/passkey/finish', (request, response) => {
  void browserFinish(request, response, 'passkey');
});

app.get('/desktop/passkey', async (request, response) => {
  try {
    const flowId = requireString(request.query.flowId, 'flowId', 256);
    const flow = await flows.get(flowId);
    if (flow.kind !== 'passkey') throw new Error('invalid_grant');

    response.type('html').send(
      '<!doctype html>' +
      '<html lang="pt-BR"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Passkey · Auto CodeZ</title>' +
      '<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a0e;color:#edf2f7;font:14px/1.55 system-ui,sans-serif}main{width:min(420px,calc(100vw - 40px));padding:36px;border:1px solid #252c36;border-radius:16px;background:#0d1117;box-sizing:border-box;text-align:center}h1{font-size:22px;margin:0 0 10px}p{color:#84909f;margin:0 0 24px}button{width:100%;height:44px;border:0;border-radius:9px;background:#356ea8;color:#fff;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:default}#passkey-message{min-height:20px;margin-top:16px;color:#7d8997;font-size:12px}#passkey-message[data-error="true"]{color:#d88484}</style>' +
      '</head><body><main><h1>Entrar com passkey</h1>' +
      '<p>Use a passkey vinculada à sua conta Auto CodeZ. Nenhuma senha será solicitada.</p>' +
      '<button type="button" id="passkey-start">Usar passkey</button>' +
      '<div id="passkey-message" aria-live="polite"></div>' +
      '<script src="/assets/passkey-client.js"></script>' +
      '</main></body></html>',
    );
  } catch {
    response.status(400).type('html').send(
      errorPage('Este fluxo de passkey expirou ou não é válido.'),
    );
  }
});

app.get('/desktop/passkey/enroll', async (request, response) => {
  try {
    await browserUser(request);
    response.type('html').send(
      '<!doctype html>' +
      '<html lang="pt-BR"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Adicionar passkey · Auto CodeZ</title>' +
      '<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a0e;color:#edf2f7;font:14px/1.55 system-ui,sans-serif}main{width:min(420px,calc(100vw - 40px));padding:36px;border:1px solid #252c36;border-radius:16px;background:#0d1117;box-sizing:border-box;text-align:center}h1{font-size:22px;margin:0 0 10px}p{color:#84909f;margin:0 0 24px}button{width:100%;height:44px;border:0;border-radius:9px;background:#356ea8;color:#fff;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:default}#passkey-message{min-height:20px;margin-top:16px;color:#7d8997;font-size:12px}#passkey-message[data-error="true"]{color:#d88484}</style>' +
      '</head><body><main><h1>Adicionar passkey</h1>' +
      '<p>Crie uma passkey para entrar no Auto CodeZ sem senha nas próximas vezes.</p>' +
      '<button type="button" id="passkey-start">Adicionar passkey</button>' +
      '<div id="passkey-message" aria-live="polite"></div>' +
      '<script src="/assets/passkey-client.js"></script>' +
      '</main></body></html>',
    );
  } catch {
    response.status(401).type('html').send(
      errorPage('Sua sessão do navegador expirou. Entre novamente com GitHub, Google, Microsoft ou Magic Link antes de adicionar uma passkey.'),
    );
  }
});

async function deviceContext(request: Request) {
  return await devices.authenticate(bearerToken(request));
}

app.post('/v1/devices/register/begin', async (request, response) => {
  try {
    const context = await deviceContext(request);
    const body = requireObject(request.body, 'body');
    response.json(await devices.beginRegistration(context, {
      id: requireString(body.id, 'device id', 256),
      name: requireString(body.name, 'device name', 80),
      platform: requireString(body.platform, 'platform', 64),
      arch: requireString(body.arch, 'arch', 64),
      appVersion: requireString(body.appVersion, 'app version', 128),
      publicKey: requireString(body.publicKey, 'public key', 8192),
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/register/complete', async (request, response) => {
  try {
    const context = await deviceContext(request);
    const body = requireObject(request.body, 'body');
    response.json(await devices.completeRegistration(context, {
      registrationId: requireString(body.registrationId, 'registration id', 256),
      deviceId: requireString(body.deviceId, 'device id', 256),
      signature: requireString(body.signature, 'signature', 16384),
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/list', async (request, response) => {
  try {
    response.json(await devices.list(await deviceContext(request)));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/rename', async (request, response) => {
  try {
    const context = await deviceContext(request);
    const body = requireObject(request.body, 'body');
    response.json(await devices.rename(
      context,
      requireString(body.deviceId, 'device id', 256),
      requireString(body.name, 'device name', 80),
    ));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/revoke', async (request, response) => {
  try {
    const context = await deviceContext(request);
    const body = requireObject(request.body, 'body');
    await devices.revoke(
      context,
      requireString(body.deviceId, 'device id', 256),
    );
    response.status(204).end();
  } catch (error) {
    sendError(response, error);
  }
});

const server = app.listen(environment.port, '0.0.0.0', () => {
  console.log('Auto CodeZ Account API listening on :' + environment.port);
});

async function shutdown(): Promise<void> {
  server.close();
  await database.close();
}

process.once('SIGTERM', () => {
  void shutdown();
});

process.once('SIGINT', () => {
  void shutdown();
});
