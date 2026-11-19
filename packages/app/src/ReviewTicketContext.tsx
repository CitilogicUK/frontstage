import { useEffect, useRef, useState } from 'react';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { appRecordUrl, scheduledReviewDate } from './reviewDue';
import {
  reviewSignoffLines,
  type ReviewSignoffs,
  type ReviewTrack,
} from './reviewTracks';

type ReviewTicketApp = Parameters<typeof scheduledReviewDate>[0] & {
  id: string;
  name: string;
  owner: string;
  team: string;
  reviewStatus: string;
  signoffs?: ReviewSignoffs;
};

function httpsTicketDestination(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password)
      return url.href;
    return undefined;
  } catch {
    return undefined;
  }
}

export function ReviewTicketContext({
  app,
  tracks,
}: {
  app: ReviewTicketApp;
  tracks: readonly ReviewTrack[];
}) {
  const config = useApi(configApiRef);
  const ticketCreateUrl = httpsTicketDestination(
    config.getOptionalString('app.reviewTicketCreateUrl'),
  );
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const copyField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (manualCopy) {
      copyField.current?.focus();
      copyField.current?.select();
    }
  }, [manualCopy]);

  async function copy() {
    const due = scheduledReviewDate(app);
    const name = app.name.replace(/\s+/gu, ' ').trim();
    const context = [
      `Tier 3 review — ${name}`,
      '',
      `Frontstage record: ${appRecordUrl(window.location.href, app.id).href}`,
      `Owner: ${app.owner}`,
      `Team: ${app.team}`,
      `Review status: ${app.reviewStatus}`,
      ...reviewSignoffLines(tracks, app.signoffs),
      ...(due ? [`Renewal due: ${due.toISOString().slice(0, 10)} UTC`] : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(context);
      setCopied(true);
      setManualCopy('');
    } catch {
      setCopied(false);
      setManualCopy(context);
      copyField.current?.focus();
      copyField.current?.select();
    }
  }

  return (
    <div>
      <button type="button" onClick={copy}>
        Copy review ticket context
      </button>
      {ticketCreateUrl && (
        <p>
          <a href={ticketCreateUrl} target="_blank" rel="noreferrer">
            Open ticket creation page (new tab)
          </a>
        </p>
      )}
      {copied && <p role="status">Review ticket context copied.</p>}
      {manualCopy && (
        <label>
          Review ticket context
          <textarea
            ref={copyField}
            readOnly
            rows={7 + tracks.length}
            value={manualCopy}
          />
        </label>
      )}
    </div>
  );
}
