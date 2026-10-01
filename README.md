# Discord Channel Exporter

A local browser app for exports from your own Discord server. It uses a bot token and the official Discord HTTP API.

## Start the app

Use Node.js 22.12 or later. Node.js 24 LTS is recommended.

```powershell
git clone https://github.com/AriaTofighi/discord-exporter.git
cd discord-exporter
npm ci
npm run dev
```

Open the URL shown in the terminal. The default is `http://127.0.0.1:4310`. If that port is in use, the app tries the next port. It listens on this computer only.

Keep the terminal open while you use the app. Press **Ctrl+C** in that terminal to stop the server. Closing the browser tab does not stop it. To run it again, open a terminal in the project folder and use `npm run dev`. You only need to run `npm ci` again when the dependencies change.

Each user must create and connect their own Discord bot. No bot token or Discord export data is included in this repository.

For a compiled frontend:

```powershell
npm run build
npm start
```

To select another port in PowerShell:

```powershell
$env:PORT = '4400'
npm run dev
```

## Set up the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications). Select **New Application** and give it a name.
2. Open **Bot**. Keep **Public Bot** off to restrict installation to you. Enable **Message Content Intent** under **Privileged Gateway Intents**. The other privileged intents are not required.
3. Use **Reset Token** if you need to create a bot token. Paste the token into this app and select **Connect bot**. Do not use a normal Discord user token.
4. Select **Invite bot** in this app. Add the bot to your server with **View Channels** and **Read Message History**. Administrator permission is not required.
5. For private channels, give the bot those same permissions in the channel overrides. To read voice channel text, also grant **Connect**.
6. Select the refresh icon in this app. Select your server and channels.

Message Content Intent applies to REST responses as well as Gateway events. The app blocks exports if the application flags do not show that it is enabled. After you change the setting, refresh the connection.

For private threads, invite the bot to the threads or grant **Manage Threads**. Without that permission, the export can include only private threads that the bot can access. A warning records this limit.

## Export

Select one or both file formats:

- **Markdown:** A readable record, in time order, with message text, authors, timestamps, reply links, embeds, attachment links, reactions, and poll data.
- **JSON:** Message objects returned by Discord. The file includes a `metadata` object and a `messages` array. When attachments are downloaded, each message has `export_metadata.attachments` with paths relative to its channel folder.

Leave both dates empty for all available history. **From** and **Through** include both selected calendar dates in your local time zone. You can also leave one date empty. The export excludes messages created after the export starts.

For **My messages only**, supply your Discord user ID. In Discord, enable **User Settings > Advanced > Developer Mode**, then right-click your profile and select **Copy User ID**. A bot token does not identify the person who uses this local app.

**Threads and forum posts** includes active and archived threads where the bot has access. It is required for forum and media channels. **Download attachments** saves direct message attachments inside the ZIP. It is off by default because large attachments increase export time and disk use.

Select **Export ZIP**. You can cancel an active export. When it is complete, select **Download ZIP**. Download the current file before you start another export or disconnect.

## Export files

```text
export.zip
  README.md
  manifest.json
  channels/
    _channel-name-CHANNEL_ID/
      messages.md
      messages.json
      attachments/
        ATTACHMENT_ID-_filename.ext
```

Each selected channel and discovered thread gets a folder. A forum channel folder contains metadata; its posts are in separate thread folders. `manifest.json` records parent channel IDs, export filters, counts, channel status, and warnings. Only selected formats are written.

Failed attachment downloads retain the original URL and produce warnings. If a channel fails after some messages have been read, its status is `partial`. If it fails before any matching messages are saved, its status is `failed`. Check the warnings and manifest before you use an export as a backup.

## Access and storage

- The bot token stays in the local server's memory. The app does not save it to browser storage, source files, or export files. Only the local server sends it to Discord.
- A browser session has its own connection and export. API responses and ZIP downloads require that session cookie. The app checks the local hostname and rejects cross-site API requests.
- The app uses Discord's rate limits and reads messages in batches of 100. It stores batches on disk so the full channel does not need to fit in memory.
- Temporary message files and the finished ZIP use the ignored `.exports` folder. These files are not encrypted. Use a trusted computer with enough free disk space for the message files, attachments, and ZIP at the same time.
- Starting another export removes the previous temporary ZIP for that session. Disconnecting removes that session's export and clears its token. A normal server shutdown also removes current exports. Inactive sessions expire after 12 hours.
- A forced shutdown or crash can leave files in `.exports`. With the server stopped, you can remove that folder through File Explorer. Files from an earlier process are not restored in the app.

## Limits

- Only content still available to the bot can be exported. Deleted messages cannot be recovered.
- An export is not an atomic server snapshot. Edits, deletions, or permission changes during an export can affect the result.
- Direct message attachments can be downloaded. Embedded media, stickers, avatars, and forwarded attachments remain remote references. Discord attachment URLs expire, so use attachment downloads for durable copies.
- Markdown is a readable representation. JSON preserves the complete message fields that Discord returns, including unsupported rich content.
- Thread discovery errors and channel read errors produce warnings. The report stores the first 500 warnings and the full warning count.
- This app exports voice channel text, not audio, server settings, or direct messages.
- Cancellation can wait for an active Discord rate-limit delay to finish.

## Development

```powershell
npm run typecheck
```

No application tests are included or run. TypeScript checks do not verify the Discord connection or live export behavior.

Source files:

- `src/`: Browser controls and styles.
- `shared/types.ts`: API data contracts.
- `server/discord.ts`: Bot access, permissions, and Discord requests.
- `server/exporter.ts`: Batched exports, attachment downloads, and ZIP files.
- `server/markdown.ts`: Markdown output and file names.
- `server/index.ts`: Local HTTP server and session handling.

## Discord references

- [Bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow)
- [Privileged intents](https://docs.discord.com/developers/events/gateway#privileged-intents)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
- [Thread access](https://docs.discord.com/developers/topics/threads#enumerating-threads)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Signed attachment URLs](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls)

## License

MIT. See [LICENSE](LICENSE).
