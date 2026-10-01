import { REST, DiscordAPIError } from '@discordjs/rest';
import {
  ApplicationFlags, ChannelType, PermissionFlagsBits, Routes,
  type APIApplication, type APIGuildMember, type APIMessage, type APIRole,
  type APIUser, type RESTGetAPICurrentUserGuildsResult,
} from 'discord-api-types/v10';
import type { Channel, Guild } from '../shared/types.js';

export interface DiscordChannel {
  id: string;
  name: string;
  type: ChannelType;
  parent_id?: string | null;
  position?: number;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
  thread_metadata?: { archive_timestamp: string };
}

export interface AccessibleChannel extends Channel {
  permissions: bigint;
}

const exportableTypes = new Set<number>([
  ChannelType.GuildText, ChannelType.GuildAnnouncement,
  ChannelType.GuildForum, ChannelType.GuildMedia,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice,
]);

export function publicError(error: unknown): string {
  if (error instanceof DiscordAPIError) {
    if (error.status === 401) return 'Discord rejected the bot token. Connect again with a current token.';
    if (error.status === 403) return 'The bot does not have permission to read this Discord resource.';
    if (error.status === 404) return 'This Discord resource no longer exists or is not accessible.';
    return `Discord could not complete the request (HTTP ${error.status}, code ${error.code}).`;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'Export cancelled.';
  return 'The request failed. Check your connection and try again.';
}

export function isForum(channel: Pick<Channel, 'type'>): boolean {
  return channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia;
}

export class DiscordClient {
  readonly rest: REST;
  user!: APIUser;
  application!: APIApplication;
  guilds: Guild[] = [];

  constructor(token: string) {
    this.rest = new REST({ version: '10', retries: 3, timeout: 20_000 }).setToken(token);
  }

  async connect(): Promise<void> {
    this.user = await this.get<APIUser>(Routes.user('@me'));
    if (!this.user.bot) throw new Error('A Discord bot token is required.');
    this.application = await this.get<APIApplication>(Routes.oauth2CurrentApplication());
    await this.refreshGuilds();
  }

  get messageContentEnabled(): boolean {
    const mask = ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited;
    return ((this.application.flags ?? 0) & mask) !== 0;
  }

  get inviteUrl(): string {
    const query = new URLSearchParams({
      client_id: this.application.id,
      scope: 'bot',
      permissions: (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory).toString(),
    });
    return `https://discord.com/oauth2/authorize?${query}`;
  }

  async get<T>(route: `/${string}`, signal?: AbortSignal, query?: URLSearchParams): Promise<T> {
    signal?.throwIfAborted();
    return await this.rest.get(route, { signal, query }) as T;
  }

  async refreshGuilds(): Promise<Guild[]> {
    const guilds: Guild[] = [];
    let after = '0';
    while (true) {
      const page = await this.get<RESTGetAPICurrentUserGuildsResult>(
        Routes.userGuilds(), undefined, new URLSearchParams({ limit: '200', after }),
      );
      guilds.push(...page.map(({ id, name, icon }) => ({ id, name, icon })));
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
    this.guilds = guilds.sort((a, b) => a.name.localeCompare(b.name));
    return this.guilds;
  }

  async channels(guildId: string, signal?: AbortSignal): Promise<AccessibleChannel[]> {
    const [channels, roles, member] = await Promise.all([
      this.get<DiscordChannel[]>(Routes.guildChannels(guildId), signal),
      this.get<APIRole[]>(Routes.guildRoles(guildId), signal),
      this.get<APIGuildMember>(Routes.guildMember(guildId, this.user.id), signal),
    ]);
    const roleIds = new Set([guildId, ...member.roles]);
    const basePermissions = roles.filter(role => roleIds.has(role.id))
      .reduce((bits, role) => bits | BigInt(role.permissions), 0n);
    const categories = new Map(channels.filter(c => c.type === ChannelType.GuildCategory).map(c => [c.id, c.name]));
    return channels.filter(c => exportableTypes.has(c.type)).map(channel => {
      let permissions = basePermissions;
      if ((permissions & PermissionFlagsBits.Administrator) !== 0n) {
        permissions = Object.values(PermissionFlagsBits).reduce((all, bit) => all | bit, 0n);
      } else {
        const overrides = channel.permission_overwrites ?? [];
        const everyone = overrides.find(o => o.id === guildId && o.type === 0);
        if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
        const roleOverrides = overrides.filter(o => o.type === 0 && o.id !== guildId && roleIds.has(o.id));
        const deny = roleOverrides.reduce((bits, o) => bits | BigInt(o.deny), 0n);
        const allow = roleOverrides.reduce((bits, o) => bits | BigInt(o.allow), 0n);
        permissions = (permissions & ~deny) | allow;
        const own = overrides.find(o => o.id === this.user.id && o.type === 1);
        if (own) permissions = (permissions & ~BigInt(own.deny)) | BigInt(own.allow);
      }
      let required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        required |= PermissionFlagsBits.Connect;
      }
      const readable = (permissions & required) === required;
      return {
        id: channel.id, name: channel.name, type: channel.type,
        parentId: channel.parent_id ?? null,
        category: categories.get(channel.parent_id ?? '') ?? 'Channels',
        position: channel.position ?? 0,
        readable, permissions,
        ...(!readable ? { reason: 'Missing View Channel, Read Message History, or voice Connect permission.' } : {}),
      };
    }).sort((a, b) => a.category.localeCompare(b.category) || a.position - b.position);
  }

  async activeThreads(guildId: string, signal: AbortSignal): Promise<DiscordChannel[]> {
    const result = await this.get<{ threads: DiscordChannel[] }>(Routes.guildActiveThreads(guildId), signal);
    return result.threads;
  }

  async *archivedThreads(channelId: string, kind: 'public' | 'private' | 'joined', signal: AbortSignal) {
    const route: `/${string}` = kind === 'joined'
      ? `/channels/${channelId}/users/@me/threads/archived/private`
      : `/channels/${channelId}/threads/archived/${kind}`;
    let before: string | undefined;
    while (true) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const result = await this.get<{ threads: DiscordChannel[]; has_more: boolean }>(route, signal, query);
      yield result.threads;
      if (!result.has_more || !result.threads.length) break;
      const last = result.threads[result.threads.length - 1];
      const next = kind === 'joined' ? last.id : last.thread_metadata?.archive_timestamp;
      if (!next || next === before) throw new Error('Discord did not advance the thread cursor.');
      before = next;
    }
  }

  messages(channelId: string, before: string, signal: AbortSignal): Promise<APIMessage[]> {
    return this.get<APIMessage[]>(Routes.channelMessages(channelId), signal,
      new URLSearchParams({ limit: '100', before }));
  }

  dispose(): void {
    this.rest.setToken('');
    this.rest.clearHashSweeper();
    this.rest.clearHandlerSweeper();
  }
}
