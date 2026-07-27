import { mapClaudeUsageToQuotaSnapshot } from '@/providers/claude/runtime/ClaudeQuotaSnapshot';

describe('mapClaudeUsageToQuotaSnapshot', () => {
  it('maps official subscription windows and extra usage without session cost', () => {
    const snapshot = mapClaudeUsageToQuotaSnapshot({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.4, resets_at: '2026-07-26T22:00:00Z' },
        seven_day: { utilization: 96.2, resets_at: '2026-07-29T12:00:00Z' },
        seven_day_opus: null,
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 12.5,
          utilization: 12.5,
          currency: 'USD',
        },
      },
    } as never, 123);

    expect(snapshot).toEqual({
      source: 'provider',
      fetchedAt: 123,
      plan: 'max',
      windows: [
        {
          id: 'five-hour',
          label: '5 hour',
          utilizationPercent: 42,
          resetsAt: Date.parse('2026-07-26T22:00:00Z'),
        },
        {
          id: 'seven-day',
          label: '7 day',
          utilizationPercent: 96,
          resetsAt: Date.parse('2026-07-29T12:00:00Z'),
        },
      ],
      extraUsage: {
        enabled: true,
        utilizationPercent: 13,
        usedCredits: 12.5,
        monthlyLimit: 100,
        currency: 'USD',
      },
    });
  });

  it('returns an unavailable snapshot when plan rate limits do not apply', () => {
    expect(mapClaudeUsageToQuotaSnapshot({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    } as never, 456)).toEqual({
      source: 'provider',
      fetchedAt: 456,
      windows: [],
      unavailableReason: 'Plan quota is unavailable for this Claude authentication method.',
    });
  });
});
