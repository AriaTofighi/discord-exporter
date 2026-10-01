import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function SetupSteps() {
  return <ol className="setup-steps">
    <li><strong>Create a Discord application</strong><p>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Developer Portal <ExternalLink size={13} /></a>, select New Application, and give it a name.</p></li>
    <li><strong>Enable message access</strong><p>On the Bot page, enable Message Content Intent. Keep Public Bot off for a private bot. You do not need Presence or Server Members intents.</p></li>
    <li><strong>Save your bot token</strong><p>Copy .env.example to .env in the project folder and set DISCORD_BOT_TOKEN to your token. Restart the app and reload the page. The bot connects automatically. Keep .env private.</p></li>
    <li><strong>Add it to your server</strong><p>After connecting, use Invite bot. Grant View Channels and Read Message History. Check channel overrides for private channels, then refresh this app.</p></li>
  </ol>;
}

export function SetupGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return <dialog ref={dialog} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} className="setup-dialog">
    <div className="dialog-header"><h2>Bot setup</h2><button className="icon-button" onClick={onClose} title="Close setup" aria-label="Close setup"><X size={20} /></button></div>
    <SetupSteps />
    <div className="setup-notes">
      <h3>Private threads</h3><p>Invite the bot to each private thread, or grant Manage Threads to include all private threads. Forum posts are included when Include threads is on.</p>
      <h3>Export only your messages</h3><p>In Discord, enable User Settings &gt; Advanced &gt; Developer Mode. Right-click your profile and select Copy User ID. Enter that ID in the author filter.</p>
      <h3>Voice channel text</h3><p>To export chat from voice channels, the bot also needs Connect permission. Audio is not exported.</p>
      <h3>Local files</h3><p>Download the ZIP before starting another export or disconnecting. Temporary files are removed on disconnect or a normal server shutdown. An unexpected shutdown can leave files in the project's .exports folder.</p>
    </div>
  </dialog>;
}
