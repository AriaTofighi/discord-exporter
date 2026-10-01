import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { ChannelType, PermissionFlagsBits, type APIAttachment } from 'discord-api-types/v10';
import type { Channel, ExportJob, ExportOptions, Guild } from '../shared/types.js';
import { DiscordClient, isForum, publicError, type AccessibleChannel, type DiscordChannel } from './discord.js';
import { channelHeading, fileName, renderMessage, type SavedMessage } from './markdown.js';

const DISCORD_EPOCH = 1420070400000;
export const EXPORT_ROOT = path.resolve('.exports');
export const activeStatus = (status: ExportJob['status']) =>
  status === 'discovering' || status === 'exporting' || status === 'packaging';

interface ChannelResult {
  id: string;
  name: string;
  parentId: string | null;
  type: number;
  status: 'complete' | 'partial' | 'failed';
  messages: number;
  folder: string;
}

export class ExportTask {
  readonly view: ExportJob;
  readonly controller = new AbortController();
  readonly directory: string;
  readonly zipPath: string;
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: DiscordClient,
    private readonly guild: Guild,
    private readonly selected: AccessibleChannel[],
    private readonly options: ExportOptions,
  ) {
    const id = randomUUID();
    this.directory = path.join(EXPORT_ROOT, id);
    this.zipPath = path.join(this.directory, 'export.zip');
    this.view = {
      id, status: 'discovering', createdAt: new Date().toISOString(), guildName: guild.name,
      currentChannel: '', channelsDone: 0, channelsTotal: selected.length,
      messagesScanned: 0, messagesExported: 0, attachmentsDownloaded: 0,
      warnings: [], warningCount: 0,
    };
  }

  start(): void {
    this.done = this.run();
  }

  cancel(): void {
    this.controller.abort();
  }

  warn(message: string): void {
    this.view.warningCount += 1;
    if (this.view.warnings.length < 500) this.view.warnings.push(message);
  }

  async remove(): Promise<void> {
    this.cancel();
    await this.done;
    await rm(this.directory, { recursive: true, force: true });
  }

  private async discover(): Promise<Channel[]> {
    const all = new Map<string, Channel>(this.selected.map(channel => [channel.id, channel]));
    if (!this.options.includeThreads) return [...all.values()];
    const signal = this.controller.signal;
    const parents = new Map(this.selected.map(channel => [channel.id, channel]));
    const add = (thread: DiscordChannel) => {
      const parent = parents.get(thread.parent_id ?? '');
      if (!parent) return;
      all.set(thread.id, {
        id: thread.id, name: thread.name, type: thread.type,
        parentId: parent.id, category: parent.name, position: 0, readable: true,
      });
      this.view.channelsTotal = all.size;
    };
    try {
      for (const thread of await this.client.activeThreads(this.guild.id, signal)) add(thread);
    } catch (error) {
      signal.throwIfAborted();
      this.warn(`Active thread discovery failed. ${publicError(error)}`);
    }
    for (const channel of this.selected) {
      signal.throwIfAborted();
      this.view.currentChannel = channel.name;
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) continue;
      const kinds: ('public' | 'private' | 'joined')[] = ['public'];
      if (channel.type === ChannelType.GuildText) {
        const canManage = (channel.permissions & PermissionFlagsBits.ManageThreads) !== 0n;
        kinds.push(canManage ? 'private' : 'joined');
        if (!canManage) this.warn(`#${channel.name}: private threads are limited to those the bot has joined. Manage Threads is required to include all private threads.`);
      }
      for (const kind of kinds) {
        try {
          for await (const threads of this.client.archivedThreads(channel.id, kind, signal)) {
            for (const thread of threads) add(thread);
          }
        } catch (error) {
          signal.throwIfAborted();
          this.warn(`#${channel.name}: archived ${kind} thread discovery failed. ${publicError(error)}`);
        }
      }
    }
    return [...all.values()];
  }

  private async download(attachment: APIAttachment, directory: string): Promise<string> {
    const url = new URL(attachment.url);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || !url.pathname.startsWith('/attachments/') || url.port || url.username || url.password) {
      throw new Error('Unsupported attachment host.');
    }
    const name = `${attachment.id}-${fileName(attachment.filename)}`;
    const destination = path.join(directory, 'attachments', name);
    await mkdir(path.dirname(destination), { recursive: true });
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180_000)]);
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Attachment download failed (HTTP ${response.status}).`);
    }
    let received = 0;
    const maxBytes = Math.max(attachment.size, 1) + 1024;
    const sizeCheck = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > maxBytes ? new Error('Attachment exceeds its declared size.') : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), sizeCheck, createWriteStream(destination), { signal });
      if (received !== attachment.size) throw new Error('Attachment size does not match Discord metadata.');
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    this.view.attachmentsDownloaded += 1;
    return `attachments/${name}`;
  }

  private async exportChannel(channel: Channel, output: string, spool: string): Promise<ChannelResult> {
    const signal = this.controller.signal;
    const folder = `${fileName(channel.name)}-${channel.id}`;
    const directory = path.join(output, 'channels', folder);
    const pageDirectory = path.join(spool, channel.id);
    await mkdir(directory, { recursive: true });
    await mkdir(pageDirectory, { recursive: true });
    const result: ChannelResult = {
      id: channel.id, name: channel.name, type: channel.type,
      parentId: channel.parentId, status: 'complete', messages: 0, folder: `channels/${folder}`,
    };
    const start = this.options.startDate ? Date.parse(this.options.startDate) : DISCORD_EPOCH;
    const end = Math.min(Date.parse(this.view.createdAt), this.options.endDate ? Date.parse(this.options.endDate) : Infinity);
    let before = (BigInt(Math.max(0, end - DISCORD_EPOCH)) << 22n).toString();
    let pages = 0;
    if (!isForum(channel)) {
      while (end > start) {
        signal.throwIfAborted();
        let page: SavedMessage[];
        try {
          page = await this.client.messages(channel.id, before, signal);
        } catch (error) {
          signal.throwIfAborted();
          result.status = pages ? 'partial' : 'failed';
          this.warn(`#${channel.name}: message export is ${result.status}. ${publicError(error)}`);
          break;
        }
        if (!page.length) break;
        this.view.messagesScanned += page.length;
        const messages = page.filter(message => {
          const timestamp = Date.parse(message.timestamp);
          return timestamp >= start && timestamp < end && (!this.options.authorId || message.author.id === this.options.authorId);
        });
        for (const message of messages) {
          signal.throwIfAborted();
          if (this.options.downloadAttachments && message.attachments.length) {
            message.export_metadata = { attachments: [] };
            for (const attachment of message.attachments) {
              try {
                const localPath = await this.download(attachment, directory);
                message.export_metadata.attachments.push({ id: attachment.id, local_path: localPath });
              } catch (error) {
                signal.throwIfAborted();
                if (['ENOSPC', 'EACCES', 'EROFS', 'EMFILE'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
                const reason = 'File download failed; the original Discord URL is retained.';
                message.export_metadata.attachments.push({ id: attachment.id, error: reason });
                this.warn(`#${channel.name}, message ${message.id}: ${attachment.filename}: ${reason}`);
              }
            }
          }
          if (message.message_snapshots?.some(snapshot => snapshot.message.attachments.length) && this.options.downloadAttachments) {
            this.warn(`#${channel.name}, message ${message.id}: forwarded attachments are kept as links.`);
          }
        }
        if (messages.length) {
          await writeFile(path.join(pageDirectory, `${pages}.json`), JSON.stringify(messages));
          pages += 1;
          result.messages += messages.length;
          this.view.messagesExported += messages.length;
        }
        const oldest = page[page.length - 1];
        if (Date.parse(oldest.timestamp) < start || page.length < 100) break;
        if (BigInt(oldest.id) >= BigInt(before)) {
          result.status = 'partial';
          this.warn(`#${channel.name}: Discord did not advance the message cursor.`);
          break;
        }
        before = oldest.id;
      }
    }
    await this.writeChannelFiles(channel, result, pageDirectory, pages, directory);
    await rm(pageDirectory, { recursive: true, force: true });
    return result;
  }

  private async writeChannelFiles(channel: Channel, result: ChannelResult, spool: string, pages: number, directory: string) {
    let json: FileHandle | null = null;
    let markdown: FileHandle | null = null;
    try {
      if (this.options.formats.includes('json')) json = await open(path.join(directory, 'messages.json'), 'w');
      if (this.options.formats.includes('markdown')) markdown = await open(path.join(directory, 'messages.md'), 'w');
      if (json) {
        const metadata = JSON.stringify({ schemaVersion: 1, exportedAt: this.view.createdAt, guild: this.guild, channel: result });
        await json.writeFile(`{"metadata":${metadata},"messages":[\n`);
      }
      if (markdown) {
        await markdown.writeFile(channelHeading(channel.name, channel.id, this.guild.name));
        if (result.status !== 'complete') await markdown.writeFile(`WARNING: ${result.status} export. See manifest.json.\n\n`);
        if (isForum(channel)) await markdown.writeFile('Posts are exported as separate thread folders. See manifest.json for parent channel IDs.\n\n');
      }
      let first = true;
      // Discord pages arrive newest first. Reverse one disk-backed page at a time.
      for (let page = pages - 1; page >= 0; page -= 1) {
        this.controller.signal.throwIfAborted();
        const messages = JSON.parse(await readFile(path.join(spool, `${page}.json`), 'utf8')) as SavedMessage[];
        for (const message of messages.reverse()) {
          if (json) await json.writeFile(`${first ? '' : ',\n'}${JSON.stringify(message)}`);
          if (markdown) await markdown.writeFile(renderMessage(message, this.guild.id));
          first = false;
        }
      }
      if (json) await json.writeFile('\n]}\n');
      if (markdown && first && !isForum(channel)) await markdown.writeFile('No messages matched this export.\n');
    } finally {
      await json?.close();
      await markdown?.close();
    }
  }

  private async zip(output: string): Promise<void> {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const destination = createWriteStream(this.zipPath);
    const signal = this.controller.signal;
    const cancel = () => { archive.abort(); destination.destroy(new Error('Export cancelled.')); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        destination.on('close', resolve);
        destination.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', reject);
        archive.pipe(destination);
        archive.directory(output, false);
        void archive.finalize().catch(reject);
      });
      signal.throwIfAborted();
    } catch (error) {
      archive.abort();
      destination.destroy();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private async run(): Promise<void> {
    const output = path.join(this.directory, 'content');
    const spool = path.join(this.directory, 'pages');
    try {
      await mkdir(output, { recursive: true });
      const channels = await this.discover();
      this.view.channelsTotal = channels.length;
      this.view.status = 'exporting';
      const results: ChannelResult[] = [];
      for (const channel of channels) {
        this.controller.signal.throwIfAborted();
        this.view.currentChannel = channel.name;
        results.push(await this.exportChannel(channel, output, spool));
        this.view.channelsDone += 1;
      }
      this.controller.signal.throwIfAborted();
      if (results.filter(result => !isForum(result)).every(result => result.status === 'failed')
        && results.some(result => !isForum(result))) {
        throw new Error('All selected message sources failed. Check bot permissions and try again.');
      }
      this.view.status = 'packaging';
      this.view.currentChannel = '';
      const manifest = {
        schemaVersion: 1, exportedAt: this.view.createdAt, finishedAt: new Date().toISOString(),
        guild: this.guild, options: this.options, channels: results,
        messages: this.view.messagesExported, attachments: this.view.attachmentsDownloaded,
        warnings: this.view.warnings, warningCount: this.view.warningCount,
        notes: [
          'Date start is inclusive; date end is exclusive. Messages created after export start are excluded.',
          'Only messages available to this bot at export time can be included. Deleted messages cannot be recovered.',
          'Message history is read in batches and is not an atomic snapshot. Concurrent edits or deletions can affect results.',
          'Raw JSON preserves fields returned by Discord. Markdown is a readable representation, not a complete schema.',
          'Only direct message attachments are downloaded. Embeds, stickers, avatars and forwarded attachments remain remote references.',
          'Signed Discord attachment URLs expire. Download attachments for durable copies.',
          'Channel folders use channel IDs to prevent name collisions. Private thread coverage depends on bot permissions.',
          'The warnings list is limited to 500 entries. warningCount records the full count.',
        ],
      };
      await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await writeFile(path.join(output, 'README.md'), `# ${this.guild.name} export\n\nExported ${this.view.createdAt}.\n\n${manifest.notes.map(note => `- ${note}`).join('\n')}\n\nSee manifest.json for filters, channel IDs, counts, and warnings.\n`);
      await this.zip(output);
      this.view.sizeBytes = (await stat(this.zipPath)).size;
      this.view.filename = `discord${fileName(this.guild.name)}-${this.view.createdAt.slice(0, 10)}.zip`;
      this.view.status = 'complete';
    } catch (error) {
      this.view.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
      if (this.view.status === 'failed') {
        this.view.error = (error as NodeJS.ErrnoException)?.code === 'ENOSPC'
          ? 'There is not enough free disk space for this export.'
          : error instanceof Error && error.message.startsWith('All selected') ? error.message
          : 'Export failed. Check your connection, bot permissions, and available disk space.';
      }
      await rm(this.zipPath, { force: true }).catch(() => {});
    } finally {
      this.view.finishedAt = new Date().toISOString();
      await rm(spool, { recursive: true, force: true }).catch(() => {});
      await rm(output, { recursive: true, force: true }).catch(() => {});
    }
  }
}
