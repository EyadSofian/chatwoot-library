import assert from 'node:assert/strict';
import test from 'node:test';
import { privateHeaders, startApp } from './support.js';

test('private assets are isolated from shared users and public media URLs', async (t) => {
  const { baseUrl, chatwoot } = await startApp(t);

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
  assert.match(privateAsset.url, /\/share\//);
  assert.match(privateAsset.contentUrl, /\/api\/assets\/.+\/content$/);

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

  const sharedPrivateFile = await fetch(privateAsset.url);
  assert.equal(sharedPrivateFile.status, 200);
  assert.equal(await sharedPrivateFile.text(), 'private content');

  const sharedContent = await fetch(
    `${baseUrl}/media/${encodeURIComponent(sharedAsset.fileName)}`
  );
  assert.equal(sharedContent.status, 200);
  assert.equal(await sharedContent.text(), 'shared content');

  const linkSend = await fetch(`${baseUrl}/api/chatwoot/send-link`, {
    method: 'POST',
    headers: privateHeaders(),
    body: JSON.stringify({
      assetIds: [sharedAsset.id, privateAsset.id],
      accountId: 7,
      conversationId: 55,
      canReply: true
    })
  });
  assert.equal(linkSend.status, 200);
  assert.equal((await linkSend.json()).count, 2);
  const linkRequest = chatwoot.requests.at(-1);
  assert.equal(linkRequest.url, '/api/v1/accounts/7/conversations/55/messages');
  const linkBody = JSON.parse(linkRequest.body);
  assert.equal(linkBody.message_type, 'outgoing');
  assert.match(linkBody.content, new RegExp(sharedAsset.fileName));
  assert.match(linkBody.content, new RegExp(privateAsset.id));

  const attachmentSend = await fetch(`${baseUrl}/api/chatwoot/send-attachment`, {
    method: 'POST',
    headers: privateHeaders(),
    body: JSON.stringify({
      assetIds: [sharedAsset.id, privateAsset.id],
      accountId: 7,
      conversationId: 55,
      canReply: true
    })
  });
  assert.equal(attachmentSend.status, 200);
  assert.equal((await attachmentSend.json()).count, 2);
  const attachmentRequest = chatwoot.requests.at(-1);
  assert.equal(attachmentRequest.url, '/api/v1/accounts/7/conversations/55/messages');
  assert.equal((attachmentRequest.body.match(/name="attachments\[\]"/g) || []).length, 2);
});
