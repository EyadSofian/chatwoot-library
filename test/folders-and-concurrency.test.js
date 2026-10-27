import assert from 'node:assert/strict';
import test from 'node:test';
import { privateHeaders, startApp } from './support.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function upload(baseUrl, files, extra = {}, headers = jsonHeaders) {
  const response = await fetch(`${baseUrl}/api/assets/base64`, {
    method: 'POST', headers,
    body: JSON.stringify({
      files: files.map((name) => ({ name, mimeType: 'text/plain', data: Buffer.from(name).toString('base64') })),
      ...extra
    })
  });
  if (response.status !== 200) assert.fail(`Upload failed: ${response.status} ${await response.text()}`);
  return response.json();
}

test('folder upload keeps paths, search finds nested files, and folder sends as links', async (t) => {
  const { baseUrl, chatwoot } = await startApp(t);
  const created = await upload(baseUrl, ['lesson.txt', 'exercise.txt'], {
    folderName: 'CFM', filePaths: ['CFM/Part 1/lesson.txt', 'CFM/Part 2/exercise.txt']
  });
  assert.ok(created.folderId);
  assert.deepEqual(created.created.map((item) => item.folderPath),
    ['CFM/Part 1/lesson.txt', 'CFM/Part 2/exercise.txt']);

  const nested = await fetch(`${baseUrl}/api/assets?packageId=${created.folderId}&q=part%202%20exercise`);
  assert.deepEqual((await nested.json()).items.map((item) => item.id), [created.created[1].id]);

  const folders = await fetch(`${baseUrl}/api/packages?q=exercise&summary=1`);
  const folderList = (await folders.json()).packages;
  assert.equal(folderList.length, 1);
  assert.equal(folderList[0].id, created.folderId);
  assert.equal(folderList[0].assets, undefined);
  assert.deepEqual(folderList[0].assetNames, ['lesson.txt', 'exercise.txt']);

  const sent = await fetch(`${baseUrl}/api/chatwoot/send-link`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ packageId: created.folderId, message: 'Your course', accountId: 7, conversationId: 55 })
  });
  assert.equal(sent.status, 200);
  const content = JSON.parse(chatwoot.requests.at(-1).body).content;
  assert.match(content, /^Your course\n\n/);
  assert.match(content, /lesson.txt/);
  assert.match(content, /exercise.txt/);
});

test('concurrent uploads retain all metadata and asset lists paginate', async (t) => {
  const { baseUrl } = await startApp(t);
  const batches = Array.from({ length: 7 }, (_, index) =>
    Array.from({ length: 10 }, (_, offset) => `file-${index * 10 + offset}.txt`));
  await Promise.all(batches.map((files) => upload(baseUrl, files)));
  const first = await fetch(`${baseUrl}/api/assets?limit=60`);
  const firstPage = await first.json();
  assert.equal(firstPage.total, 70);
  assert.equal(firstPage.items.length, 60);
  const second = await fetch(`${baseUrl}/api/assets?limit=60&offset=60`);
  const secondPage = await second.json();
  assert.equal(secondPage.items.length, 10);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 70);
});

test('private folder and search results stay isolated', async (t) => {
  const { baseUrl } = await startApp(t);
  const created = await upload(baseUrl, ['private.txt'], {
    folderName: 'Ahmed Notes', filePaths: ['Ahmed Notes/private.txt']
  }, privateHeaders());
  const shared = await fetch(`${baseUrl}/api/packages?q=private&summary=1`);
  assert.deepEqual((await shared.json()).packages, []);
  const unauthorized = await fetch(`${baseUrl}/api/assets?q=Ahmed`, {
    headers: { 'x-library-scope': 'private' }
  });
  assert.equal(unauthorized.status, 403);
  const authorized = await fetch(`${baseUrl}/api/assets?q=Ahmed`, { headers: privateHeaders() });
  assert.deepEqual((await authorized.json()).items.map((item) => item.id), [created.created[0].id]);
});

test('multipart folder paths are saved and invalid batch data leaves the library unchanged', async (t) => {
  const { baseUrl } = await startApp(t);
  const form = new FormData();
  form.append('files', new Blob(['lesson'], { type: 'text/plain' }), 'lesson.txt');
  form.append('filePaths', JSON.stringify(['Course/Module/lesson.txt']));
  form.append('folderName', 'Course');
  const uploaded = await fetch(`${baseUrl}/api/assets`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 200);
  const asset = (await uploaded.json()).created[0];
  assert.equal(asset.folderPath, 'Course/Module/lesson.txt');

  const invalid = await fetch(`${baseUrl}/api/assets/base64`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ files: [
      { name: 'valid.txt', data: Buffer.from('valid').toString('base64') },
      { name: 'invalid.txt', data: 'not base64!' }
    ] })
  });
  assert.equal(invalid.status, 400);
  const list = await fetch(`${baseUrl}/api/assets`);
  assert.deepEqual((await list.json()).items.map((item) => item.id), [asset.id]);
});
