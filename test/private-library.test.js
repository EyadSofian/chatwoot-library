import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ownerEmail = 'ahmed.farouk@engosoft.com';
const privatePin = 'test-private-pin';

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl, child) {
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

function privateHeaders(overrides = {}) {
  return {
    'Content-Type': 'application/json',
    'x-library-scope': 'private',
    'x-agent-email': ownerEmail,
    'x-private-library-pin': privatePin,
    ...overrides
  };
}

test('private assets are isolated from shared users and public media URLs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatwoot-library-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      UPLOAD_DIR: path.join(root, 'uploads'),
      LIBRARY_FILE: path.join(root, 'library.json'),
      PRIVATE_LIBRARY_EMAIL: ownerEmail,
      PRIVATE_LIBRARY_PIN: privatePin
    },
    stdio: 'ignore'
  });

  t.after(async () => {
    child.kill();
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child);

  const sharedUpload = await fetch(`${baseUrl}/api/assets/base64`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{
        name: 'shared.txt',
        mimeType: 'text/plain',
        data: Buffer.from('shared content').toString('base64')
      }]
    })
  });
  assert.equal(sharedUpload.status, 200);
  const sharedAsset = (await sharedUpload.json()).created[0];

  const privateForm = new FormData();
  privateForm.append(
    'files',
    new Blob(['private content'], { type: 'text/plain' }),
    'private.txt'
  );
  const multipartHeaders = privateHeaders();
  delete multipartHeaders['Content-Type'];
  const privateUpload = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: multipartHeaders,
    body: privateForm
  });
  assert.equal(privateUpload.status, 200);
  const privateAsset = (await privateUpload.json()).created[0];
  assert.equal(privateAsset.visibility, 'private');
  assert.equal(privateAsset.isPublic, false);

  const sharedList = await fetch(`${baseUrl}/api/assets`);
  assert.equal(sharedList.status, 200);
  assert.deepEqual((await sharedList.json()).items.map((item) => item.id), [sharedAsset.id]);

  const unauthenticatedPrivateList = await fetch(`${baseUrl}/api/assets`, {
    headers: { 'x-library-scope': 'private' }
  });
  assert.equal(unauthenticatedPrivateList.status, 403);

  const wrongOwnerList = await fetch(`${baseUrl}/api/assets`, {
    headers: privateHeaders({ 'x-agent-email': 'someone.else@engosoft.com' })
  });
  assert.equal(wrongOwnerList.status, 403);

  const privateList = await fetch(`${baseUrl}/api/assets`, {
    headers: privateHeaders()
  });
  assert.equal(privateList.status, 200);
  assert.deepEqual((await privateList.json()).items.map((item) => item.id), [privateAsset.id]);

  const publicPrivateFile = await fetch(
    `${baseUrl}/media/${encodeURIComponent(privateAsset.fileName)}`
  );
  assert.equal(publicPrivateFile.status, 404);

  const unauthenticatedContent = await fetch(
    `${baseUrl}/api/assets/${privateAsset.id}/content`
  );
  assert.equal(unauthenticatedContent.status, 404);

  const privateContent = await fetch(
    `${baseUrl}/api/assets/${privateAsset.id}/content`,
    { headers: privateHeaders() }
  );
  assert.equal(privateContent.status, 200);
  assert.equal(await privateContent.text(), 'private content');

  const sharedContent = await fetch(
    `${baseUrl}/media/${encodeURIComponent(sharedAsset.fileName)}`
  );
  assert.equal(sharedContent.status, 200);
  assert.equal(await sharedContent.text(), 'shared content');
});
