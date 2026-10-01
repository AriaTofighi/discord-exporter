# Discord Channel Exporter

Export Discord channels, threads, and forum posts to **Markdown or JSON**, with optional attachments. Runs locally in your browser and uses your own Discord bot.

## Run

Install [Node.js](https://nodejs.org/) 22.12 or later, then run:

```sh
git clone https://github.com/AriaTofighi/discord-exporter.git
cd discord-exporter
npm ci
```

Copy `.env.example` to `.env` in the project folder and add your bot token (see below):

```dotenv
DISCORD_BOT_TOKEN=your_bot_token
```

Run `npm run dev`. The bot connects automatically when you open the app.

Open the address shown in the terminal, usually `http://localhost:4310`. Keep the terminal open while you use the app. Press **Ctrl+C** to stop it.

To start it again, run `npm run dev` from the project folder.

## Connect a bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On its **Bot** page, enable **Message Content Intent**. Create a bot token and save it as `DISCORD_BOT_TOKEN` in `.env`. Restart the app after changing this file.
3. Select **Invite bot** and add it to your server with **View Channels** and **Read Message History**. Then refresh the app.

For private channels, allow those permissions in the channel settings too. For all private threads, grant **Manage Threads**; otherwise, add the bot to each thread you need. Voice channel text also requires **Connect**. Administrator permission is not needed.

## Export

Select a server, channels, and file formats, then select **Export ZIP**. When the export is ready, select **Download ZIP**.

- Leave the dates empty to export all available history.
- Use **My messages only** with your Discord user ID to filter by author.
- Enable **Threads and forum posts** to include active and archived threads the bot can access.
- Enable **Download attachments** to save attached files instead of relying on links that can expire.

Check any warnings for missing content. Deleted messages and content the bot cannot access cannot be exported.

## Data and privacy

Your token is saved in your local `.env` file and is never sent to the browser. Git ignores `.env`; only the blank `.env.example` is included in this repository. Keep `.env` private. Disconnecting does not erase the saved token. Exports are stored unencrypted in `.exports/`, which Git also ignores.

**Download your ZIP before you start another export, disconnect, or stop the app.** These actions remove the current temporary export. A crash can leave files in `.exports/`; you can delete that folder after you stop the app.

## License

[MIT](LICENSE)
