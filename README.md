# Chatwoot Library App

Standalone media library for Chatwoot teams. It lets agents upload images, videos, audio, and files, then copy direct public URLs for WhatsApp templates, campaign headers, and internal sharing.

## Features

- Multiple file upload.
- Drag and drop upload area.
- Grid preview for images, video, audio, and files.
- Search by file name, tags, and notes.
- Filter by type: images, video, audio, files.
- Copy direct public URL.
- Open and download files from `/media/...`.
- Delete files.
- Optional upload/admin PIN.
- Local disk storage with JSON metadata.

## Deploy

### Railway or Coolify

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Port:

```bash
3000
```

## Environment Variables

```env
PORT=3000
PUBLIC_BASE_URL=https://library.yourdomain.com
MAX_FILE_MB=100
LIBRARY_PIN=change-this-pin
UPLOAD_DIR=/app/storage/uploads
LIBRARY_FILE=/app/storage/library.json
CHATWOOT_URL=https://chat.yourdomain.com
CHATWOOT_ACCOUNT_ID=2
CHATWOOT_API_TOKEN=your-chatwoot-agent-token
```

`PUBLIC_BASE_URL` is important when the app is behind a proxy, because generated links must be HTTPS direct links.

## Persistent Storage

If you deploy on Coolify, add a persistent volume for:

```text
/app/storage
```

Without a persistent volume, files may be lost after redeploys or container rebuilds.

## Chatwoot Dashboard App

In Chatwoot:

1. Go to Settings.
2. Integrations.
3. Dashboard Apps.
4. Add a new app.
5. Name: `Library`.
6. URL: your deployed app URL.

Media files under `/media/...` remain public so WhatsApp and Chatwoot can fetch them directly.

## Send Files Into The Current Chatwoot Conversation

When the app is opened as a Chatwoot Dashboard App, it reads the current conversation context using Chatwoot's `appContext` postMessage event.

Each library item has:

- `Send link`: sends the public file URL as an outgoing text message.
- `Send file`: sends the file as an outgoing Chatwoot attachment using multipart upload.

For this to work, set:

```env
CHATWOOT_URL=https://chat.yourdomain.com
CHATWOOT_ACCOUNT_ID=2
CHATWOOT_API_TOKEN=your-chatwoot-agent-token
```

Do not put `CHATWOOT_API_TOKEN` in the browser or inside `public/index.html`.

For WhatsApp conversations, normal replies only work while Chatwoot reports `can_reply=true`. If the 24-hour WhatsApp window is closed, send an approved WhatsApp template instead.

## Supported File Types

Images:

```text
jpg, jpeg, png, webp, gif, svg
```

Video:

```text
mp4, webm, mov
```

Audio:

```text
mp3, wav, m4a, ogg
```

Files:

```text
pdf, doc, docx, xls, xlsx, csv, txt, zip
```

## Notes

- Use direct HTTPS URLs in Chatwoot and WhatsApp templates.
- Google Drive links are usually not direct media URLs, so avoid them for template headers.
- If the URL opens only after login, WhatsApp will not be able to fetch it.
