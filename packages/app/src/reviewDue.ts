export function isReviewOverdue(
  app: {
    tier: number;
    lifecycle: string;
    reviewStatus: string;
    nextReview: string | null;
  },
  now: number,
) {
  if (app.lifecycle === 'retired' || (app.tier !== 2 && app.tier !== 3))
    return false;

  const due = scheduledReviewDate(app);
  if (due) return due.getTime() <= now;

  // An initial Tier 3 decision has no scheduled renewal yet.
  return app.tier === 2 || app.reviewStatus === 'approved';
}

function calendarText(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[,;]/g, '\\$&');
}

function foldCalendarLine(line: string) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const character of line) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += character;
    bytes += length;
  }
  return result;
}

export function scheduledReviewDate(app: {
  tier: number;
  lifecycle: string;
  nextReview: string | null;
}) {
  if (
    app.lifecycle === 'retired' ||
    (app.tier !== 2 && app.tier !== 3) ||
    !app.nextReview
  )
    return undefined;
  const due = new Date(app.nextReview);
  return Number.isFinite(due.getTime()) ? due : undefined;
}

export function appRecordUrl(baseUrl: string, appId: string) {
  const url = new URL(baseUrl);
  url.search = new URLSearchParams({ app: appId }).toString();
  url.hash = '';
  return url;
}

export function reviewCalendar(
  reminders: Array<{
    app: { id: string; name: string; tier: number };
    due: Date;
  }>,
  baseUrl: string,
  now = new Date(),
) {
  const timestamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const events = reminders.flatMap(({ app, due }) => {
    const title = app.tier === 2 ? 'App attestation' : 'App review';
    const recordUrl = appRecordUrl(baseUrl, app.id);
    return [
      'BEGIN:VEVENT',
      `UID:${calendarText(app.id)}-review@${recordUrl.hostname}`,
      `DTSTAMP:${timestamp}`,
      `DTSTART;VALUE=DATE:${due.toISOString().slice(0, 10).replace(/-/g, '')}`,
      `SUMMARY:${calendarText(`${title}: ${app.name}`)}`,
      `URL:${recordUrl.href}`,
      'BEGIN:VALARM',
      'TRIGGER:-P7D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${title} due in seven days`,
      'END:VALARM',
      'END:VEVENT',
    ];
  });
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Frontstage//App governance//EN',
    ...events,
    'END:VCALENDAR',
    '',
  ]
    .map(foldCalendarLine)
    .join('\r\n');
}

export function requiresCriticalReview(
  app: {
    tier: number;
    lifecycle: string;
    reviewStatus: string;
    nextReview: string | null;
  },
  now: number,
) {
  return (
    app.tier === 3 &&
    app.lifecycle !== 'retired' &&
    (app.reviewStatus !== 'approved' ||
      !app.nextReview ||
      isReviewOverdue(app, now))
  );
}
