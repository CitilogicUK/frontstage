import { z } from 'zod';
import { nextReview } from './policy';

export const reviewTrack = z.enum(['security', 'dataProtection']);
export type ReviewTrack = z.infer<typeof reviewTrack>;
const reviewerRef = z.string().regex(/^user:[a-z0-9_.-]+\/[a-z0-9_.-]+$/);

export const reviewTrackConfig = z
  .object({
    security: z.array(reviewerRef).min(1),
    dataProtection: z.array(reviewerRef).min(1),
  })
  .strict()
  .refine(
    config => !config.security.some(ref => config.dataProtection.includes(ref)),
    {
      message: 'Security and Data Protection reviewers must be distinct.',
    },
  );

export type Signoffs = Partial<
  Record<
    ReviewTrack,
    {
      status: 'approved' | 'changes needed';
      actor: string;
      at: string;
      notes: string;
    }
  >
>;

function assignedSignoff(
  signoffs: Signoffs | undefined,
  configuration: z.infer<typeof reviewTrackConfig>,
  track: ReviewTrack,
) {
  const decision = signoffs?.[track];
  return decision && configuration[track].includes(decision.actor)
    ? decision
    : undefined;
}

export function currentSignoffs(
  signoffs: Signoffs | undefined,
  configuration: z.infer<typeof reviewTrackConfig>,
  now: number,
): Signoffs {
  const current: Signoffs = {};
  for (const track of reviewTrack.options) {
    const decision = assignedSignoff(signoffs, configuration, track);
    if (!decision) continue;
    const expiry = nextReview(3, decision.at);
    if (
      decision.status === 'approved' &&
      (!expiry || Date.parse(expiry) <= now)
    )
      continue;
    current[track] = decision;
  }
  return current;
}

export function trackedReview(
  signoffs: Signoffs | undefined,
  configuration: z.infer<typeof reviewTrackConfig>,
  now: number,
) {
  const decisions = reviewTrack.options.map(track =>
    assignedSignoff(signoffs, configuration, track),
  );
  if (decisions.some(decision => decision?.status === 'changes needed')) {
    return { reviewStatus: 'changes needed', nextReview: null } as const;
  }
  const dueDates = decisions
    .flatMap(decision => {
      if (decision?.status !== 'approved') return [];
      const due = nextReview(3, decision.at);
      return due ? [due] : [];
    })
    .sort();
  if (dueDates.length === reviewTrack.options.length) {
    const expiry = dueDates[0];
    return {
      reviewStatus: Date.parse(expiry) > now ? 'approved' : 'pending',
      nextReview: expiry,
    } as const;
  }
  return { reviewStatus: 'pending', nextReview: null } as const;
}
