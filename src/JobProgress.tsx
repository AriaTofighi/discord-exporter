import { AlertTriangle, CheckCircle2, Download, LoaderCircle, Square, XCircle } from 'lucide-react';
import type { ExportJob } from '../shared/types';

export const isActive = (job: ExportJob | null) => Boolean(job && ['discovering', 'exporting', 'packaging'].includes(job.status));

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function JobProgress({ job, onCancel, cancelling }: { job: ExportJob; onCancel: () => void; cancelling: boolean }) {
  const active = isActive(job);
  const titles = {
    discovering: 'Finding channels and threads', exporting: 'Exporting messages', packaging: 'Creating ZIP file',
    complete: 'Export ready', failed: 'Export failed', cancelled: 'Export cancelled',
  };
  const percent = job.channelsTotal ? Math.round(job.channelsDone / job.channelsTotal * 100) : 0;
  return <section className={`job-section ${job.status}`} aria-labelledby="job-title">
    <div className="job-header">
      <div className="job-title" role="status">
        {active ? <LoaderCircle className="spin" size={21} /> : job.status === 'complete' ? <CheckCircle2 size={21} /> : <XCircle size={21} />}
        <h2 id="job-title">{titles[job.status]}</h2>
      </div>
      {active && <button type="button" className="secondary compact" onClick={onCancel} disabled={cancelling}><Square size={14} />{cancelling ? 'Cancelling...' : 'Cancel'}</button>}
      {job.status === 'complete' && <a className="primary compact" href={`/api/exports/${job.id}/download`} download><Download size={17} />Download ZIP</a>}
    </div>
    <p className="job-detail">{job.guildName}{job.currentChannel ? ` / #${job.currentChannel}` : ''}{job.status === 'complete' && job.sizeBytes !== undefined ? ` / ${fileSize(job.sizeBytes)}` : ''}</p>
    {active && <progress max={100} {...(job.status === 'exporting' ? { value: percent } : {})} aria-label="Export progress" />}
    <div className="job-counts">
      <span><strong>{job.messagesExported.toLocaleString()}</strong> messages exported</span>
      <span><strong>{job.channelsDone} / {job.channelsTotal}</strong> channels</span>
      <span><strong>{job.attachmentsDownloaded.toLocaleString()}</strong> files saved</span>
    </div>
    {job.status === 'exporting' && <p className="muted small">{job.messagesScanned.toLocaleString()} messages read</p>}
    {job.error && <p className="error-text" role="alert">{job.error}</p>}
    {job.status === 'cancelled' && <p className="muted small">No ZIP was saved. Start a new export to try again.</p>}
    {job.warningCount > 0 && <details className="warnings"><summary><AlertTriangle size={16} />{job.warningCount} {job.warningCount === 1 ? 'warning' : 'warnings'}</summary>
      <ul>{job.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      {job.warningCount > job.warnings.length && <p>Showing the first {job.warnings.length} warnings.</p>}
    </details>}
  </section>;
}
