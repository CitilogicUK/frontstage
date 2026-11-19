export const reviewTrackLabels = {
  security: 'Security',
  dataProtection: 'Data Protection',
};
export type ReviewTrack = keyof typeof reviewTrackLabels;

export type ReviewSignoffs = Partial<Record<ReviewTrack, { status: string }>>;

export function reviewSignoffLines(
  tracks: readonly ReviewTrack[],
  signoffs?: ReviewSignoffs,
) {
  return tracks.map(
    track =>
      `${reviewTrackLabels[track]} sign-off: ${
        signoffs?.[track]?.status ?? 'pending'
      }`,
  );
}
