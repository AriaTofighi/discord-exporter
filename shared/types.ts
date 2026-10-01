export interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

export interface Channel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  category: string;
  position: number;
  readable: boolean;
  reason?: string;
}

export interface ExportOptions {
  guildId: string;
  channelIds: string[];
  formats: ('markdown' | 'json')[];
  startDate?: string;
  endDate?: string;
  authorId?: string;
  includeThreads: boolean;
  downloadAttachments: boolean;
}

export type JobStatus = 'discovering' | 'exporting' | 'packaging' | 'complete' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  guildName: string;
  currentChannel: string;
  channelsDone: number;
  channelsTotal: number;
  messagesScanned: number;
  messagesExported: number;
  attachmentsDownloaded: number;
  warnings: string[];
  warningCount: number;
  error?: string;
  filename?: string;
  sizeBytes?: number;
}

export interface SessionView {
  hasConfiguredToken: boolean;
  connectionError: string | null;
  bot: { id: string; username: string; avatarUrl: string | null } | null;
  guilds: Guild[];
  messageContentEnabled: boolean;
  inviteUrl: string | null;
  job: ExportJob | null;
}
