import assert from 'node:assert/strict';
import test from 'node:test';
import { privateHeaders, startApp } from './support.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function uploadText(baseUrl, name, { headers = jsonHeaders, tags = '', notes = '' } = {}) {
  const response = await fetch(`${baseUrl}/api/assets/base64`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      files: [{ name, mimeType: 'text/plain', data: Buffer.from(name).toString('base64') }],
      tags,
      notes
    })
  });
  assert.equal(response.status, 200);
  return (await response.json()).created[0];
}

async function searchIds(baseUrl, q, headers = {}) {
  const response = await fetch(`${baseUrl}/api/assets?${new URLSearchParams({ q })}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).items.map((item) => item.id).sort();
}

test('search matches case, separators, multiple words and package names', async (t) => {
  const { baseUrl } = await startApp(t);

  const cfmPart1 = await uploadText(baseUrl, 'CFM-Part1.txt');
  const cfmTagged = await uploadText(baseUrl, 'lecture.txt', { tags: 'cfm, finance' });
  const cfmNotes = await uploadText(baseUrl, 'intro.txt', { notes: 'مقدمة كورس C.F.M' });
  const other = await uploadText(baseUrl, 'pmp-guide.txt');
  const arabic = await uploadText(baseUrl, 'إدارة-المشروعات.txt');

  assert.deepEqual(
    await searchIds(baseUrl, 'cfm'),
    [cfmPart1.id, cfmTagged.id, cfmNotes.id].sort()
  );
  assert.deepEqual(await searchIds(baseUrl, 'CFM part1'), [cfmPart1.id]);
  assert.deepEqual(await searchIds(baseUrl, 'cfm finance'), [cfmTagged.id]);
  assert.deepEqual(await searchIds(baseUrl, 'اداره'), [arabic.id]);
  assert.deepEqual(await searchIds(baseUrl, 'nothing-matches'), []);

  const created = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'Project Bundle', assetIds: [other.id] })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await searchIds(baseUrl, 'project bundle'), [other.id]);
});

test('packages group files, are searchable and send in one Chatwoot message', async (t) => {
  const { baseUrl, chatwoot } = await startApp(t);

  const first = await uploadText(baseUrl, 'CFM-1.txt');
  const second = await uploadText(baseUrl, 'CFM-2.txt');
  const unrelated = await uploadText(baseUrl, 'PMP.txt');

  const missingName = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: ' ', assetIds: [first.id] })
  });
  assert.equal(missingName.status, 400);

  const createResponse = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'CFM', description: 'CFM course', assetIds: [first.id, second.id] })
  });
  assert.equal(createResponse.status, 201);
  const pkg = (await createResponse.json()).package;
  assert.equal(pkg.count, 2);
  assert.equal(pkg.visibility, 'shared');

  const duplicate = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'cfm', assetIds: [] })
  });
  assert.equal(duplicate.status, 409);

  const found = await fetch(`${baseUrl}/api/packages?q=cf`);
  assert.deepEqual((await found.json()).packages.map((item) => item.id), [pkg.id]);
  const notFound = await fetch(`${baseUrl}/api/packages?q=pmp`);
  assert.deepEqual((await notFound.json()).packages, []);

  const filtered = await fetch(`${baseUrl}/api/assets?packageId=${pkg.id}`);
  const filteredItems = (await filtered.json()).items;
  assert.deepEqual(filteredItems.map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(filteredItems[0].packages, [{ id: pkg.id, name: 'CFM' }]);

  const added = await fetch(`${baseUrl}/api/packages/${pkg.id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ addAssetIds: [unrelated.id, first.id] })
  });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).package.assetIds, [first.id, second.id, unrelated.id]);

  const removed = await fetch(`${baseUrl}/api/packages/${pkg.id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ removeAssetIds: [unrelated.id] })
  });
  assert.equal((await removed.json()).package.count, 2);

  const sendFiles = await fetch(`${baseUrl}/api/chatwoot/send-attachment`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ packageId: pkg.id, accountId: 7, conversationId: 55, canReply: true })
  });
  assert.equal(sendFiles.status, 200);
  const sendFilesBody = await sendFiles.json();
  assert.equal(sendFilesBody.count, 2);
  assert.equal(sendFilesBody.packageId, pkg.id);
  assert.equal(chatwoot.requests.length, 1);
  assert.equal((chatwoot.requests[0].body.match(/name="attachments\[\]"/g) || []).length, 2);

  const sendLinks = await fetch(`${baseUrl}/api/chatwoot/send-link`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ packageId: pkg.id, accountId: 7, conversationId: 55, canReply: true })
  });
  assert.equal(sendLinks.status, 200);
  const linkContent = JSON.parse(chatwoot.requests.at(-1).body).content;
  assert.match(linkContent, /^CFM\n/);
  assert.match(linkContent, new RegExp(first.fileName));
  assert.match(linkContent, new RegExp(second.fileName));

  const deleteAsset = await fetch(`${baseUrl}/api/assets/${second.id}`, { method: 'DELETE' });
  assert.equal(deleteAsset.status, 200);
  const afterDelete = await fetch(`${baseUrl}/api/packages/${pkg.id}`);
  assert.deepEqual((await afterDelete.json()).package.assetIds, [first.id]);

  const deletePackage = await fetch(`${baseUrl}/api/packages/${pkg.id}`, { method: 'DELETE' });
  assert.equal(deletePackage.status, 200);
  const gone = await fetch(`${baseUrl}/api/packages/${pkg.id}`);
  assert.equal(gone.status, 404);
  const assetStillThere = await searchIds(baseUrl, 'CFM-1');
  assert.deepEqual(assetStillThere, [first.id]);
});

test('private packages stay private and shared packages reject private files', async (t) => {
  const { baseUrl } = await startApp(t);

  const shared = await uploadText(baseUrl, 'shared-cfm.txt');
  const privateAsset = await uploadText(baseUrl, 'private-cfm.txt', { headers: privateHeaders() });

  const leak = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: privateHeaders({ 'x-library-scope': 'shared' }),
    body: JSON.stringify({ name: 'Leak', assetIds: [privateAsset.id] })
  });
  assert.equal(leak.status, 400);

  const anonymousPrivateAsset = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'Guess', assetIds: [privateAsset.id] })
  });
  assert.equal(anonymousPrivateAsset.status, 404);

  const created = await fetch(`${baseUrl}/api/packages`, {
    method: 'POST',
    headers: privateHeaders(),
    body: JSON.stringify({ name: 'Ahmed CFM', assetIds: [privateAsset.id, shared.id] })
  });
  assert.equal(created.status, 201);
  const pkg = (await created.json()).package;
  assert.equal(pkg.visibility, 'private');
  assert.equal(pkg.count, 2);

  const sharedList = await fetch(`${baseUrl}/api/packages`);
  assert.deepEqual((await sharedList.json()).packages, []);

  const privateList = await fetch(`${baseUrl}/api/packages?q=ahmed`, { headers: privateHeaders() });
  assert.deepEqual((await privateList.json()).packages.map((item) => item.id), [pkg.id]);

  const anonymousRead = await fetch(`${baseUrl}/api/packages/${pkg.id}`);
  assert.equal(anonymousRead.status, 404);

  const anonymousSend = await fetch(`${baseUrl}/api/chatwoot/send-attachment`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ packageId: pkg.id, accountId: 7, conversationId: 55, canReply: true })
  });
  assert.equal(anonymousSend.status, 404);

  const anonymousDelete = await fetch(`${baseUrl}/api/packages/${pkg.id}`, { method: 'DELETE' });
  assert.equal(anonymousDelete.status, 404);

  const sharedSearch = await searchIds(baseUrl, 'ahmed cfm');
  assert.deepEqual(sharedSearch, []);
  const privateSearch = await searchIds(baseUrl, 'ahmed cfm', privateHeaders());
  assert.deepEqual(privateSearch, [privateAsset.id]);
});
