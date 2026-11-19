import { useEffect, useRef, useState } from 'react';
import { appRecordUrl, scheduledReviewDate } from './reviewDue';

type ReviewTicketApp = Parameters<typeof scheduledReviewDate>[0] & {
  id: string;
  name: string;
  owner: string;
  team: string;
  reviewStatus: string;
};

export function ReviewTicketContext({ app }: { app: ReviewTicketApp }) {
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
    const context = [
      `Tier 3 review — ${app.name}`,
      '',
      `Frontstage record: ${appRecordUrl(window.location.href, app.id).href}`,
      `Owner: ${app.owner}`,
      `Team: ${app.team}`,
      `Review status: ${app.reviewStatus}`,
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
      {copied && <p role="status">Review ticket context copied.</p>}
      {manualCopy && (
        <label>
          Review ticket context
          <textarea ref={copyField} readOnly rows={7} value={manualCopy} />
        </label>
      )}
    </div>
  );
}
