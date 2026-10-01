import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { DiscordClient, isForum, publicError } from './discord.js';
import { ExportTask, activeStatus } from './exporter.js';
import type { SessionView } from '../shared/types.js';

interface Session {
  client?: DiscordClient;
  initialConnection?: Promise<void>;
  connectionError?: string;
  job?: ExportTask;
  busy: boolean;
  touched: number;
  attempts: number[];
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const app = express();
const sessions = new Map<string, Session>();
const production = process.argv.includes('--production');
try { loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read .env. Check its file permissions.');
}
const configuredToken = process.env.DISCORD_BOT_TOKEN?.trim() ?? '';
const snowflake = z.string().regex(/^\d{17,20}$/, 'Enter a valid Discord ID.');
const optionsSchema = z.object({
  guildId: snowflake,
  channelIds: z.array(snowflake).min(1, 'Select at least one channel.').max(500),
  formats: z.array(z.enum(['markdown', 'json'])).min(1, 'Select an export format.').max(2),
  startDate: z.iso.datetime({ offset: true }).optional(),
  endDate: z.iso.datetime({ offset: true }).optional(),
  authorId: snowflake.optional(),
  includeThreads: z.boolean(),
  downloadAttachments: z.boolean(),
}).refine(value => !value.startDate || !value.endDate || Date.parse(value.startDate) < Date.parse(value.endDate), {
  message: 'The start date must be before the end date.',
});

let port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');

app.disable('x-powered-by');
app.use((req, res, next) => {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host ?? '')) return res.status(403).send('Local connections only.');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  const expected = `http://${req.headers.host}`;
  if ((origin && origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'Use the local app to make this request.' });
  }
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-exporter-request'] !== '1') {
    return res.status(403).json({ error: 'Missing local request header.' });
  }
  next();
}, express.json({ limit: '32kb' }), (req, res, next) => {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('exporterSession='));
  const id = cookie?.slice('exporterSession='.length);
  let session = id ? sessions.get(id) : undefined;
  if (!session) {
    if (sessions.size >= 16) return res.status(429).json({ error: 'Too many local sessions. Restart the app to clear them.' });
    const newId = randomBytes(32).toString('hex');
    session = { busy: false, touched: Date.now(), attempts: [] };
    sessions.set(newId, session);
    res.cookie('exporterSession', newId, { httpOnly: true, sameSite: 'strict', path: '/api' });
  }
  session.touched = Date.now();
  res.locals.session = session;
  next();
});

function sessionOf(res: Response): Session {
  return res.locals.session as Session;
}

function clientOf(res: Response): DiscordClient {
  const client = sessionOf(res).client;
  if (!client) throw new HttpError(401, 'Connect your Discord bot first.');
  return client;
}

function view(session: Session): SessionView {
  const client = session.client;
  return {
    bot: client ? {
      id: client.user.id, username: client.user.username,
      avatarUrl: client.user.avatar ? `https://cdn.discordapp.com/avatars/${client.user.id}/${client.user.avatar}.png?size=64` : null,
    } : null,
    guilds: client?.guilds ?? [], messageContentEnabled: client?.messageContentEnabled ?? false,
    inviteUrl: client?.inviteUrl ?? null, job: session.job?.view ?? null,
    hasConfiguredToken: Boolean(configuredToken), connectionError: session.connectionError ?? null,
  };
}

async function exclusive<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  if (session.busy) throw new HttpError(409, 'Another request is in progress. Try again in a moment.');
  session.busy = true;
  try { return await operation(); } finally { session.busy = false; }
}

async function connectBot(session: Session): Promise<void> {
  await exclusive(session, async () => {
    if (!configuredToken || !/^\S{20,256}$/.test(configuredToken)) {
      throw new HttpError(400, 'Set DISCORD_BOT_TOKEN in .env, then restart the app.');
    }
    if (session.job && activeStatus(session.job.view.status)) throw new HttpError(409, 'Cancel the current export before reconnecting.');
    session.attempts = session.attempts.filter(time => time > Date.now() - 60_000);
    if (session.attempts.length >= 5) throw new HttpError(429, 'Wait one minute before trying to connect again.');
    session.attempts.push(Date.now());
    const client = new DiscordClient(configuredToken);
    try { await client.connect(); } catch (error) { client.dispose(); throw error; }
    session.client?.dispose();
    session.client = client;
    delete session.connectionError;
  });
}

app.get('/api/session', async (_req, res) => {
  const session = sessionOf(res);
  // Share the first connection attempt across concurrent page loads. An explicit
  // disconnect leaves this promise settled, so a refresh does not reconnect.
  if (configuredToken) {
    session.initialConnection ??= connectBot(session).catch(error => {
      session.connectionError = error instanceof HttpError ? error.message
        : `Could not connect with DISCORD_BOT_TOKEN. Check .env and restart the app, or retry if your connection was interrupted. ${publicError(error)}`;
    });
    await session.initialConnection;
  }
  res.json(view(session));
});

app.post('/api/connect', async (_req, res) => {
  const session = sessionOf(res);
  await connectBot(session);
  session.initialConnection ??= Promise.resolve();
  res.json(view(session));
});

app.post('/api/disconnect', async (_req, res) => {
  const session = sessionOf(res);
  await exclusive(session, async () => {
    try {
      if (session.job) await session.job.remove();
    } finally {
      session.client?.dispose();
      delete session.client;
      delete session.job;
      delete session.connectionError;
      session.initialConnection ??= Promise.resolve();
    }
  });
  res.json(view(session));
});

app.post('/api/refresh', async (_req, res) => {
  const client = clientOf(res);
  await exclusive(sessionOf(res), async () => { await client.connect(); });
  res.json(view(sessionOf(res)));
});

app.get('/api/guilds/:guildId/channels', async (req, res) => {
  const guildId = snowflake.parse(req.params.guildId);
  const client = clientOf(res);
  if (!client.guilds.some(guild => guild.id === guildId)) throw new HttpError(404, 'This server is not available to the bot.');
  const channels = await client.channels(guildId);
  res.json({ channels: channels.map(({ permissions: _permissions, ...channel }) => channel) });
});

app.post('/api/exports', async (req, res) => {
  const options = optionsSchema.parse(req.body);
  options.channelIds = [...new Set(options.channelIds)];
  options.formats = [...new Set(options.formats)];
  const session = sessionOf(res);
  await exclusive(session, async () => {
    const client = clientOf(res);
    if (!client.messageContentEnabled) throw new HttpError(400, 'Enable Message Content Intent for this bot, then refresh the connection.');
    if (session.job && activeStatus(session.job.view.status)) throw new HttpError(409, 'An export is already in progress.');
    const guild = client.guilds.find(item => item.id === options.guildId);
    if (!guild) throw new HttpError(404, 'This server is not available to the bot.');
    const channels = await client.channels(guild.id);
    const selected = channels.filter(channel => options.channelIds.includes(channel.id));
    if (selected.length !== options.channelIds.length || selected.some(channel => !channel.readable)) {
      throw new HttpError(400, 'One or more channels are missing or cannot be read. Refresh the channel list.');
    }
    if (!options.includeThreads && selected.some(isForum)) throw new HttpError(400, 'Include threads to export forum or media posts.');
    if (session.job) await session.job.remove();
    session.job = new ExportTask(client, guild, selected, options);
    session.job.start();
  });
  res.status(202).json(session.job!.view);
});

app.get('/api/exports/:id', (req, res) => {
  const job = sessionOf(res).job;
  if (!job || job.view.id !== req.params.id) throw new HttpError(404, 'This export is no longer available.');
  res.json(job.view);
});

app.post('/api/exports/:id/cancel', (req, res) => {
  const job = sessionOf(res).job;
  if (!job || job.view.id !== req.params.id) throw new HttpError(404, 'This export is no longer available.');
  job.cancel();
  res.json(job.view);
});

app.get('/api/exports/:id/download', async (req, res) => {
  const job = sessionOf(res).job;
  if (!job || job.view.id !== req.params.id || job.view.status !== 'complete') {
    throw new HttpError(404, 'The export file is not available.');
  }
  await access(job.zipPath);
  // The session-owned ZIP is inside .exports, which sendFile otherwise blocks as a dotfile path.
  res.download(job.zipPath, job.view.filename!, { dotfiles: 'allow' });
});

app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown request.' }); });
app.use('/api', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.' });
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request.' });
  res.status(502).json({ error: publicError(error) });
});

const server = createServer(app);
const vite = production ? undefined : await (await import('vite')).createServer({
  server: {
    middlewareMode: true, hmr: { server },
    watch: { ignored: ['**/.exports/**', '**/.npm-cache/**'] },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.exports/**', '**/.npm-cache/**', '**/server/**'] },
  },
  appType: 'custom',
});

if (production) {
  await access(path.resolve('dist/index.html')).catch(() => { throw new Error('Run npm run build before npm start.'); });
  app.use(express.static(path.resolve('dist')));
} else {
  app.use(vite!.middlewares);
}

app.get('/', async (req, res, next) => {
  try {
    const html = await readFile(path.resolve(production ? 'dist/index.html' : 'index.html'), 'utf8');
    res.type('html').send(vite ? await vite.transformIndexHtml(req.originalUrl, html) : html);
  } catch (error) { next(error); }
});

const sweep = setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.touched < Date.now() - 12 * 60 * 60 * 1000 && !session.busy && (!session.job || !activeStatus(session.job.view.status))) {
      sessions.delete(id);
      session.client?.dispose();
      void session.job?.remove().catch(() => {});
    }
  }
}, 60_000).unref();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(sweep);
  server.close();
  const cleanup = [...sessions.values()].map(async session => {
    await session.initialConnection;
    await session.job?.remove();
    session.client?.dispose();
  });
  await Promise.allSettled(cleanup);
  await vite?.close();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

async function listen() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      console.log(`Discord Channel Exporter is ready at http://127.0.0.1:${port}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port >= 65535) throw error;
      port += 1;
    }
  }
  throw new Error('Could not find an available local port. Set PORT to another value.');
}
await listen();
