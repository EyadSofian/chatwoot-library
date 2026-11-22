import assert from 'node:assert/strict';
import test from 'node:test';
import { privateHeaders, startApp } from './support.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function upload(baseUrl, name, headers = jsonHeaders) {
  const response = await fetch(`${baseUrl}/api/assets/base64`, {
    method: 'POST', headers,
    body: JSON.stringify({ files: [{ name, mimeType: 'text/plain', data: Buffer.from(name).toString('base64') }] })
  });
  assert.equal(response.status, 200);
  return (await response.json()).created[0].id;
}

async function list(baseUrl, type, headers = {}) {
  const response = await fetch(`${baseUrl}/api/${type}`, { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  return (data.items || data.packages).map((item) => item.id);
}

async function move(baseUrl, type, movedId, anchorId, placement, headers = jsonHeaders) {
  return fetch(`${baseUrl}/api/${type}/order`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ movedId, anchorId, placement })
  });
}

test('file and collection order persists and private cards stay isolated', async (t) => {
  const { baseUrl } = await startApp(t);
  const first = await upload(baseUrl, 'first.txt');
  const second = await upload(baseUrl, 'second.txt');
  const third = await upload(baseUrl, 'third.txt');
  assert.deepEqual(await list(baseUrl, 'assets'), [third, second, first]);

  const reordered = await move(baseUrl, 'assets', first, third, 'before');
  assert.equal(reordered.status, 200);
  assert.deepEqual(await list(baseUrl, 'assets'), [first, third, second]);
  const invalid = await move(baseUrl, 'assets', second, 'missing', 'after');
  assert.equal(invalid.status, 404);
  assert.deepEqual(await list(baseUrl, 'assets'), [first, third, second]);

  const newer = await upload(baseUrl, 'newer.txt');
  assert.deepEqual(await list(baseUrl, 'assets'), [newer, first, third, second]);

  const privateFirst = await upload(baseUrl, 'private-first.txt', privateHeaders());
  const privateSecond = await upload(baseUrl, 'private-second.txt', privateHeaders());
  const forbidden = await move(baseUrl, 'assets', privateFirst, privateSecond, 'before');
  assert.equal(forbidden.status, 404);
  const denied = await move(baseUrl, 'assets', privateFirst, privateSecond, 'before', {
    ...jsonHeaders, 'x-library-scope': 'private'
  });
  assert.equal(denied.status, 403);
  const privateMove = await move(baseUrl, 'assets', privateFirst, privateSecond, 'before', privateHeaders());
  assert.equal(privateMove.status, 200);
  assert.deepEqual(await list(baseUrl, 'assets', privateHeaders()), [privateFirst, privateSecond]);
  assert.deepEqual(await list(baseUrl, 'assets'), [newer, first, third, second]);

  const packageIds = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const response = await fetch(`${baseUrl}/api/packages`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ name, assetIds: [first] })
    });
    assert.equal(response.status, 201);
    packageIds.push((await response.json()).package.id);
  }
  assert.equal((await move(baseUrl, 'packages', packageIds[0], packageIds[2], 'before')).status, 200);
  assert.deepEqual(await list(baseUrl, 'packages'), [packageIds[0], packageIds[2], packageIds[1]]);
  assert.equal((await move(baseUrl, 'packages', packageIds[0], packageIds[1], 'middle')).status, 400);

  const privatePackages = [];
  for (const name of ['Jackie A', 'Jackie B']) {
    const response = await fetch(`${baseUrl}/api/packages`, {
      method: 'POST', headers: privateHeaders(),
      body: JSON.stringify({ name, assetIds: [privateFirst] })
    });
    assert.equal(response.status, 201);
    privatePackages.push((await response.json()).package.id);
  }
  assert.equal((await move(baseUrl, 'packages', privatePackages[0], privatePackages[1], 'before')).status, 404);
  assert.equal((await move(baseUrl, 'packages', privatePackages[0], privatePackages[1], 'before', privateHeaders())).status, 200);
  assert.deepEqual(await list(baseUrl, 'packages', privateHeaders()), privatePackages);
  assert.deepEqual(await list(baseUrl, 'packages'), [packageIds[0], packageIds[2], packageIds[1]]);
});
