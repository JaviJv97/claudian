import { mapCodexRateLimitsToQuotaSnapshot } from '@/providers/codex/runtime/CodexQuotaSnapshot';

describe('mapCodexRateLimitsToQuotaSnapshot', () => {
  it('maps primary and secondary account windows using server durations', () => {
    expect(mapCodexRateLimitsToQuotaSnapshot({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 18.6, windowDurationMins: 300, resetsAt: 1_785_100_000 },
        secondary: { usedPercent: 53.2, windowDurationMins: 10_080, resetsAt: 1_785_200_000 },
        planType: 'pro',
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }, 789)).toEqual({
      source: 'provider',
      fetchedAt: 789,
      plan: 'pro',
      windows: [
        {
          id: 'five-hour',
          label: '5 hour',
          utilizationPercent: 19,
          resetsAt: 1_785_100_000_000,
        },
        {
          id: 'seven-day',
          label: '7 day',
          utilizationPercent: 53,
          resetsAt: 1_785_200_000_000,
        },
      ],
    });
  });

  it('keeps provider labels for nonstandard windows', () => {
    const snapshot = mapCodexRateLimitsToQuotaSnapshot({
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: { usedPercent: 4, windowDurationMins: 60, resetsAt: null },
        secondary: null,
        planType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }, 1);

    expect(snapshot.windows[0]).toMatchObject({ label: '60 min', utilizationPercent: 4 });
  });
});
