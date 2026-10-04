import crypto from 'node:crypto';
import express, { type Request } from 'express';
import { loadAccountDataEnvironment } from './account-data-env.js';
import { Database } from './db.js';
import { DescopeSessionVerifier } from './descope-session-verifier.js';
import { DeviceRegistryService } from './device-registry.js';
import {
  bearerToken,
  requireObject,
  requireString,
  sendError,
} from './http.js';

const environment = loadAccountDataEnvironment();
const database = new Database(environment);
const verifier = new DescopeSessionVerifier(environment.descopeProjectId, {
  baseUrl: environment.descopeBaseUrl,
});
const devices = new DeviceRegistryService(database, undefined, Date.now, verifier);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (request.path.startsWith('/v1/devices/')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
  }
  next();
});

app.use(express.json({ limit: '128kb' }));

app.get('/healthz', async (_request, response) => {
  try {
    await database.query('SELECT 1');
    response.json({ ok: true });
  } catch {
    response.status(503).json({ ok: false });
  }
});

async function deviceContext(request: Request) {
  return await devices.authenticate(bearerToken(request));
}

async function registeredDeviceContext(request: Request) {
  const context = await deviceContext(request);
  const proof = (() => {
    try {
      const deviceId = requireString(request.header('x-autocodez-device-id'), 'device proof id', 256);
      const timestampText = requireString(request.header('x-autocodez-device-timestamp'), 'device proof timestamp', 32);
      const timestamp = Number(timestampText);
      if (!Number.isFinite(timestamp)) throw new Error('invalid timestamp');
      const nonce = requireString(request.header('x-autocodez-device-nonce'), 'device proof nonce', 128);
      const signature = requireString(request.header('x-autocodez-device-signature'), 'device proof signature', 16_384);
      const bodyHash = crypto.createHash('sha256')
        .update(JSON.stringify(request.body ?? {}), 'utf8')
        .digest('base64url');
      return {
        deviceId,
        pathname: request.path,
        timestamp,
        nonce,
        bodyHash,
        signature,
      };
    } catch {
      throw new Error('forbidden');
    }
  })();
  return await devices.authenticateDeviceRequest(context, proof);
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
      signature: requireString(body.signature, 'signature', 16_384),
    }));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/list', async (request, response) => {
  try {
    response.json(await devices.list(await registeredDeviceContext(request)));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/v1/devices/rename', async (request, response) => {
  try {
    const context = await registeredDeviceContext(request);
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
    const context = await registeredDeviceContext(request);
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
  console.log('Auto CodeZ Account Data Service listening on :' + environment.port);
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
