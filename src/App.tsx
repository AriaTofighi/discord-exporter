import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, Check, ChevronRight, Download, ExternalLink, Eye, EyeOff, FileJson2, FileText, Hash, HelpCircle, LoaderCircle, LockKeyhole, LogOut, MessageSquare, RefreshCw, Search, Server, Volume2, X } from 'lucide-react';
import type { Channel, ExportJob, ExportOptions, SessionView } from '../shared/types';
import { api, ApiError, errorMessage } from './api';
import { JobProgress, isActive } from './JobProgress';
import { SetupGuide, SetupSteps } from './SetupGuide';

const emptySession: SessionView = { bot: null, guilds: [], messageContentEnabled: false, inviteUrl: null, job: null };

function ChannelIcon({ type }: { type: number }) {
  return type === 15 || type === 16 ? <MessageSquare size={17} /> : type === 2 || type === 13 ? <Volume2 size={17} /> : <Hash size={17} />;
}

function dateBoundary(value: string, nextDay = false): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

export function App() {
  const [session, setSession] = useState<SessionView>(emptySession);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progressError, setProgressError] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [guildId, setGuildId] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelError, setChannelError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [formats, setFormats] = useState<ExportOptions['formats']>(['markdown', 'json']);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [authorOnly, setAuthorOnly] = useState(false);
  const [authorId, setAuthorId] = useState('');
  const [includeThreads, setIncludeThreads] = useState(true);
  const [downloadAttachments, setDownloadAttachments] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = isActive(job);
  const visibleError = error || progressError;

  useEffect(() => {
    const controller = new AbortController();
    api<SessionView>('/session', { signal: controller.signal }).then(data => {
      setSession(data); setJob(data.job); setGuildId(data.guilds[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setChannels([]); setSelected(new Set()); setChannelError('');
    if (!guildId || !session.bot) { setChannelsLoading(false); return; }
    const controller = new AbortController();
    setChannelsLoading(true);
    api<{ channels: Channel[] }>(`/guilds/${guildId}/channels`, { signal: controller.signal })
      .then(data => { setChannels(data.channels); })
      .catch(error => { if (!controller.signal.aborted) setChannelError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setChannelsLoading(false); });
    return () => controller.abort();
  }, [guildId, session.bot?.id, refreshKey]);

  useEffect(() => {
    if (!job || !isActive(job)) { setCancelling(false); setProgressError(''); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await api<ExportJob>(`/exports/${job.id}`, { signal: controller.signal });
        setProgressError('');
        setJob(updated);
        if (isActive(updated)) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          try {
            const current = await api<SessionView>('/session', { signal: controller.signal });
            setSession(current); setJob(current.job); setProgressError('');
            setGuildId(id => current.guilds.some(guild => guild.id === id) ? id : current.guilds[0]?.id ?? '');
            if (!current.bot) setError('The local session ended. Connect your bot again.');
          } catch (recoveryError) {
            if (controller.signal.aborted) return;
            setProgressError(errorMessage(recoveryError));
            timer = setTimeout(poll, 3000);
          }
        } else {
          setProgressError('Progress is unavailable. Check that the local server is still running. Retrying...');
          timer = setTimeout(poll, 3000);
        }
      }
    };
    timer = setTimeout(poll, 800);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, active]);

  const visibleChannels = useMemo(() => channels.filter(channel =>
    `${channel.name} ${channel.category}`.toLowerCase().includes(search.toLowerCase())), [channels, search]);
  const groups = useMemo(() => {
    const result = new Map<string, Channel[]>();
    for (const channel of visibleChannels) result.set(channel.category, [...(result.get(channel.category) ?? []), channel]);
    return [...result.entries()];
  }, [visibleChannels]);
  const selectedChannels = channels.filter(channel => selected.has(channel.id));
  const hasForum = selectedChannels.some(channel => channel.type === 15 || channel.type === 16);
  const dateError = startDate && endDate && startDate > endDate ? 'The end date must be on or after the start date.' : '';
  const authorError = authorOnly && !/^\d{17,20}$/.test(authorId.trim()) ? 'Enter your Discord user ID.' : '';
  const canExport = selected.size > 0 && formats.length > 0 && !dateError && !authorError && (!hasForum || includeThreads)
    && session.messageContentEnabled && !active && !busy && !channelsLoading;
  const guild = session.guilds.find(item => item.id === guildId);

  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const value = token.trim(); setToken(''); setShowToken(false);
    try {
      const data = await api<SessionView>('/connect', { body: { token: value } });
      setSession(data); setJob(data.job); setGuildId(data.guilds[0]?.id ?? '');
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true); setError('');
    try {
      const data = await api<SessionView>('/refresh', { body: {} });
      setSession(data); setJob(data.job);
      setGuildId(current => data.guilds.some(guild => guild.id === current) ? current : data.guilds[0]?.id ?? '');
      setRefreshKey(key => key + 1);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError('');
    try {
      await api('/disconnect', { body: {} });
      setSession(emptySession); setGuildId(''); setJob(null); setToken('');
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function startExport(event: FormEvent) {
    event.preventDefault();
    if (!canExport) return;
    setBusy(true); setError('');
    try {
      const options: ExportOptions = {
        guildId, channelIds: [...selected], formats, includeThreads, downloadAttachments,
        startDate: dateBoundary(startDate), endDate: dateBoundary(endDate, true),
        ...(authorOnly ? { authorId: authorId.trim() } : {}),
      };
      setJob(await api<ExportJob>('/exports', { body: options }));
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }

  async function cancelExport() {
    if (!job) return;
    setCancelling(true); setError('');
    try { await api(`/exports/${job.id}/cancel`, { body: {} }); }
    catch (error) { setError(errorMessage(error)); setCancelling(false); }
  }

  function toggleChannel(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return <>
    <header className="app-header"><div className="header-inner">
      <div className="brand"><Hash size={26} strokeWidth={2.2} /><h1>Discord Channel Exporter</h1></div>
      <button className="text-button" onClick={() => setGuideOpen(true)}><HelpCircle size={18} /><span>Bot setup</span></button>
    </div></header>
    <main className="app-main">
      {visibleError && <div className="error-banner" role="alert"><AlertCircle size={19} /><span>{visibleError}</span><button className="icon-button" title="Dismiss error" aria-label="Dismiss error" onClick={() => { setError(''); setProgressError(''); }}><X size={18} /></button></div>}
      {loading ? <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>Loading local session...</span></div> : !session.bot ?
        <div className="connect-layout">
          <section className="connect-section">
            <div className="section-marker"><LockKeyhole size={22} /></div>
            <h2>Connect your bot</h2>
            <form onSubmit={connect} className="connect-form">
              <label htmlFor="bot-token">Bot token</label>
              <div className="token-field"><input id="bot-token" type={showToken ? 'text' : 'password'} value={token} onChange={event => setToken(event.target.value)} placeholder="Paste your Discord bot token" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={20} maxLength={256} disabled={busy} />
                <button className="icon-button" type="button" onClick={() => setShowToken(value => !value)} title={showToken ? 'Hide token' : 'Show token'} aria-label={showToken ? 'Hide token' : 'Show token'}>{showToken ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
              <p className="field-note">The token stays in this local server's memory until you disconnect or stop the server.</p>
              <button className="primary" disabled={busy || !token.trim()}>{busy ? <LoaderCircle size={18} className="spin" /> : <LockKeyhole size={18} />}{busy ? 'Connecting...' : 'Connect bot'}</button>
            </form>
            <div className="format-note"><FileText size={18} /><span>Markdown</span><span className="separator">/</span><FileJson2 size={18} /><span>JSON</span></div>
          </section>
          <aside className="setup-section"><h2>First-time setup</h2><SetupSteps /></aside>
        </div> : <>
          <section className="connection-bar" aria-label="Discord connection">
            <div className="bot-identity">{session.bot.avatarUrl ? <img src={session.bot.avatarUrl} alt="" width={32} height={32} /> : <Server size={23} />}<div><strong>{session.bot.username}</strong><span className="muted small">Bot connected</span></div></div>
            <div className="connection-actions">
              {session.inviteUrl && <a className="text-button" href={session.inviteUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />Invite bot</a>}
              <button className="icon-button" title="Refresh servers and permissions" aria-label="Refresh servers and permissions" onClick={refresh} disabled={busy || active}><RefreshCw size={18} className={busy ? 'spin' : ''} /></button>
              <button className="icon-button" title="Disconnect and remove temporary export files" aria-label="Disconnect and remove temporary export files" onClick={disconnect} disabled={busy || active}><LogOut size={18} /></button>
            </div>
          </section>
          {!session.messageContentEnabled && <div className="notice" role="alert"><AlertCircle size={19} /><span>Enable <strong>Message Content Intent</strong> on the bot's Developer Portal page, then refresh the connection.</span></div>}
          {!session.guilds.length ? <section className="empty-servers"><Server size={32} /><h2>No servers available</h2><p>Add the bot to your private server, then refresh.</p><div className="button-row">{session.inviteUrl && <a className="primary" href={session.inviteUrl} target="_blank" rel="noreferrer"><ExternalLink size={17} />Invite bot</a>}<button className="secondary" onClick={refresh} disabled={busy}><RefreshCw size={17} />Refresh</button></div></section> :
            <form onSubmit={startExport}>
              <div className="workspace">
                <section className="channel-pane" aria-labelledby="channels-title">
                  <label htmlFor="server-select" className="field-label">Server</label>
                  <div className="server-select">{guild?.icon ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`} alt="" width={28} height={28} /> : <Server size={21} />}<select id="server-select" value={guildId} onChange={event => { setGuildId(event.target.value); setSearch(''); }} disabled={active || busy}>{session.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></div>
                  <div className="channel-heading"><h2 id="channels-title">Channels</h2><span>{selected.size} selected</span></div>
                  <div className="search-field"><Search size={17} /><input aria-label="Search channels" placeholder="Find a channel" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />{search && <button className="icon-button" type="button" title="Clear search" aria-label="Clear search" onClick={() => setSearch('')}><X size={15} /></button>}</div>
                  <div className="selection-actions"><button type="button" className="text-button" disabled={active || busy || !visibleChannels.some(channel => channel.readable)} onClick={() => setSelected(current => new Set([...current, ...visibleChannels.filter(channel => channel.readable).map(channel => channel.id)]))}>Select {search ? 'results' : 'all'}</button><button type="button" className="text-button" disabled={active || busy || selected.size === 0} onClick={() => setSelected(new Set())}>Clear</button></div>
                  <div className="channel-list">
                    {channelsLoading ? <div className="pane-state"><LoaderCircle size={20} className="spin" />Loading channels...</div> : channelError ? <div className="pane-state error-text"><AlertCircle size={20} /><p>{channelError}</p><button className="secondary compact" type="button" onClick={() => setRefreshKey(key => key + 1)}><RefreshCw size={15} />Retry</button></div> : !visibleChannels.length ? <div className="pane-state">{search ? 'No matching channels.' : 'No exportable channels are available.'}</div> : groups.map(([category, items]) => <div className="channel-group" key={category}>
                      <h3>{category}</h3>{items.map(channel => <label className={`channel-row ${selected.has(channel.id) ? 'selected' : ''} ${!channel.readable ? 'unavailable' : ''}`} key={channel.id} title={channel.reason ?? channel.name}>
                        <input type="checkbox" checked={selected.has(channel.id)} disabled={!channel.readable || active || busy} onChange={() => toggleChannel(channel.id)} /><ChannelIcon type={channel.type} /><span>{channel.name}</span>{!channel.readable && <LockKeyhole size={14} />}
                      </label>)}
                    </div>)}
                  </div>
                </section>
                <section className="options-pane" aria-labelledby="options-title">
                  <h2 id="options-title">Export settings</h2>
                  <fieldset disabled={active || busy} className="settings-fields">
                    <legend className="sr-only">Export settings</legend>
                    <div className="settings-group"><h3>File format</h3><div className="format-options">
                      {(['markdown', 'json'] as const).map(format => <label className={`format-option ${formats.includes(format) ? 'chosen' : ''}`} key={format}><input type="checkbox" checked={formats.includes(format)} onChange={() => setFormats(current => current.includes(format) ? current.filter(item => item !== format) : [...current, format])} />{format === 'markdown' ? <FileText size={21} /> : <FileJson2 size={21} />}<span><strong>{format === 'markdown' ? 'Markdown' : 'JSON'}</strong><small>{format === 'markdown' ? '.md' : '.json'}</small></span>{formats.includes(format) && <Check size={17} className="format-check" />}</label>)}
                    </div>{!formats.length && <p className="error-text small">Select at least one format.</p>}</div>
                    <div className="settings-group"><div className="group-heading"><h3>Date range</h3>{(startDate || endDate) && <button className="text-button" type="button" onClick={() => { setStartDate(''); setEndDate(''); }}>All time</button>}</div>
                      <div className="date-fields"><label>From<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label>Through<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>
                      <p className="field-note">{dateError || (startDate || endDate ? 'Dates use your local time zone. Both selected dates are included.' : 'All available messages.')}</p>
                    </div>
                    <div className="settings-group"><h3>Author</h3><div className="segmented" role="group" aria-label="Message authors"><button type="button" aria-pressed={!authorOnly} className={!authorOnly ? 'active' : ''} onClick={() => setAuthorOnly(false)}>All authors</button><button type="button" aria-pressed={authorOnly} className={authorOnly ? 'active' : ''} onClick={() => setAuthorOnly(true)}>My messages only</button></div>
                      {authorOnly && <label className="author-field">Your Discord user ID<input value={authorId} onChange={event => setAuthorId(event.target.value)} inputMode="numeric" placeholder="User ID" aria-invalid={Boolean(authorError)} required pattern="[0-9]{17,20}" /><button type="button" className="text-button" onClick={() => setGuideOpen(true)}>Find my user ID <HelpCircle size={14} /></button></label>}
                    </div>
                    <div className="settings-group include-group"><h3>Include</h3><label className="option-row"><span><strong>Threads and forum posts</strong><small>Active and archived, where the bot has access</small></span><input className="switch" role="switch" type="checkbox" checked={includeThreads} onChange={event => setIncludeThreads(event.target.checked)} /></label>
                      <label className="option-row"><span><strong>Download attachments</strong><small>Save attached files inside the ZIP</small></span><input className="switch" role="switch" type="checkbox" checked={downloadAttachments} onChange={event => setDownloadAttachments(event.target.checked)} /></label>
                      {!includeThreads && hasForum && <p className="error-text small">Enable threads to export the selected forum or media channels.</p>}
                    </div>
                  </fieldset>
                </section>
              </div>
              <div className="export-bar"><div><strong>{selected.size ? `${selected.size} ${selected.size === 1 ? 'channel' : 'channels'} selected` : 'Select channels to export'}</strong><span>{formats.length ? formats.map(format => format === 'markdown' ? 'Markdown' : 'JSON').join(' + ') : 'No format selected'}<ChevronRight size={14} />ZIP archive</span></div><button className="primary export-button" disabled={!canExport} type="submit">{busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}{active ? 'Export in progress' : 'Export ZIP'}</button></div>
              {job?.status === 'complete' && <p className="replacement-note">Download the current ZIP before starting another export. A new export replaces it.</p>}
            </form>}
          {job && <JobProgress job={job} onCancel={cancelExport} cancelling={cancelling} />}
        </>}
      <footer><LockKeyhole size={13} /><span>Runs on this computer</span><span className="footer-dot">/</span><span>Discord bot access</span></footer>
    </main>
    <SetupGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
  </>;
}
