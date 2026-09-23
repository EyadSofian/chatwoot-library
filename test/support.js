import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ownerEmail = 'ahmed.farouk@engosoft.com';
export const privatePin = 'test-private-pin';

export async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

export async function startMockChatwoot() {
  const port = await availablePort();
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 9000 + requests.length }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before startup with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the test server');
}

export function privateHeaders(overrides = {}) {
  return {
    'Content-Type': 'application/json',
    'x-library-scope': 'private',
    'x-agent-email': ownerEmail,
    'x-private-library-pin': privatePin,
    ...overrides
  };
}

export async function startApp(t, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatwoot-library-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const chatwoot = await startMockChatwoot();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      UPLOAD_DIR: path.join(root, 'uploads'),
      LIBRARY_FILE: path.join(root, 'library.json'),
      PRIVATE_LIBRARY_EMAIL: ownerEmail,
      PRIVATE_LIBRARY_PIN: privatePin,
      CHATWOOT_URL: chatwoot.baseUrl,
      CHATWOOT_API_TOKEN: 'test-token',
      ...extraEnv
    },
    stdio: 'ignore'
  });

  t.after(async () => {
    child.kill();
    await chatwoot.close();
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child);
  return { baseUrl, chatwoot, child };
}
