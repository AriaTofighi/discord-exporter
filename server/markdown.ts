import type { APIMessage } from 'discord-api-types/v10';

export type SavedMessage = APIMessage & {
  export_metadata?: { attachments: { id: string; local_path?: string; error?: string }[] };
};

export function fileName(value: string): string {
  const clean = value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 90);
  return `_${clean || 'untitled'}`;
}

function label(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function link(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    return url.split('/').map(segment => encodeURIComponent(segment)
      .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)).join('/');
  }
  return url.replace(/[\s<>()]/g, character => `%${character.charCodeAt(0).toString(16)}`);
}

export function renderMessage(message: SavedMessage, guildId: string): string {
  const author = message.author.global_name ?? message.author.username;
  const source = `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
  const lines = [
    `### ${label(author)} | ${message.timestamp}`,
    '',
    `[Open in Discord](${source})${message.edited_timestamp ? ` | Edited ${message.edited_timestamp}` : ''}${message.pinned ? ' | Pinned' : ''}`,
  ];
  if (message.message_reference?.message_id) {
    const reference = message.message_reference;
    lines.push(`Reply to [${reference.message_id}](https://discord.com/channels/${reference.guild_id ?? guildId}/${reference.channel_id ?? message.channel_id}/${reference.message_id})`);
  }
  if (message.type !== 0 && message.type !== 19) lines.push(`Message type: ${message.type}`);
  if (message.content) lines.push('', message.content);
  for (const attachment of message.attachments) {
    const saved = message.export_metadata?.attachments.find(item => item.id === attachment.id);
    lines.push('', `[Attachment: ${label(attachment.filename)}](${link(saved?.local_path ?? attachment.url)})`);
    if (attachment.description) lines.push(label(attachment.description));
    if (saved?.error) lines.push(`Download unavailable: ${saved.error}`);
  }
  for (const embed of message.embeds) {
    if (embed.title) lines.push('', `**${label(embed.title)}**`);
    if (embed.description) lines.push('', embed.description);
    if (embed.url) lines.push('', `[Embedded link](${link(embed.url)})`);
    for (const field of embed.fields ?? []) lines.push('', `**${label(field.name)}**`, field.value);
    if (embed.image?.url) lines.push('', `[Embedded image](${link(embed.image.url)})`);
    if (embed.video?.url) lines.push('', `[Embedded video](${link(embed.video.url)})`);
    if (embed.footer?.text) lines.push('', label(embed.footer.text));
  }
  for (const sticker of message.sticker_items ?? []) lines.push('', `Sticker: ${label(sticker.name)} (${sticker.id})`);
  if (message.poll) {
    lines.push('', `Poll: ${label(message.poll.question.text ?? '')}`);
    for (const answer of message.poll.answers) {
      const votes = message.poll.results?.answer_counts.find(item => item.id === answer.answer_id)?.count;
      lines.push(`- ${label(answer.poll_media.text ?? answer.poll_media.emoji?.name ?? 'Answer')}${votes === undefined ? '' : `: ${votes} votes`}`);
    }
  }
  if (message.reactions?.length) {
    lines.push('', `Reactions: ${message.reactions.map(reaction =>
      `${reaction.emoji.name ?? reaction.emoji.id ?? 'emoji'} (${reaction.count})`).join(', ')}`);
  }
  for (const snapshot of message.message_snapshots ?? []) {
    lines.push('', 'Forwarded message:', '', snapshot.message.content || '(No text)');
    for (const attachment of snapshot.message.attachments) {
      lines.push('', `[Forwarded attachment: ${label(attachment.filename)}](${link(attachment.url)})`);
    }
  }
  return `${lines.join('\n')}\n\n---\n\n`;
}

export function channelHeading(name: string, id: string, guildName: string): string {
  return `# ${label(guildName)} / #${label(name)}\n\nChannel ID: ${id}\n\nMessages are ordered oldest first. Timestamps use Discord's original timezone offset.\n\n`;
}
