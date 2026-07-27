import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../core/runtime/types';

interface ClaudeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface ClaudeUsageResponse {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: ClaudeUsageWindow | null;
    seven_day?: ClaudeUsageWindow | null;
    seven_day_oauth_apps?: ClaudeUsageWindow | null;
    seven_day_opus?: ClaudeUsageWindow | null;
    seven_day_sonnet?: ClaudeUsageWindow | null;
    model_scoped?: Array<ClaudeUsageWindow & { display_name: string }>;
    extra_usage?: {
      is_enabled: boolean;
      monthly_limit: number | null;
      used_credits: number | null;
      utilization: number | null;
      currency?: string | null;
    } | null;
  } | null;
}

function toWindow(
  id: string,
  label: string,
  value: ClaudeUsageWindow | null | undefined,
): ProviderQuotaWindow | null {
  if (!value || value.utilization === null || !Number.isFinite(value.utilization)) return null;
  const reset = value.resets_at ? Date.parse(value.resets_at) : Number.NaN;
  return {
    id,
    label,
    utilizationPercent: Math.max(0, Math.round(value.utilization)),
    ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
  };
}

export function mapClaudeUsageToQuotaSnapshot(
  response: ClaudeUsageResponse,
  fetchedAt = Date.now(),
): ProviderQuotaSnapshot {
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      source: 'provider',
      fetchedAt,
      windows: [],
      unavailableReason: 'Plan quota is unavailable for this Claude authentication method.',
    };
  }

  const limits = response.rate_limits;
  const windows = [
    toWindow('five-hour', '5 hour', limits.five_hour),
    toWindow('seven-day', '7 day', limits.seven_day),
    toWindow('seven-day-oauth-apps', '7 day OAuth apps', limits.seven_day_oauth_apps),
    toWindow('seven-day-opus', '7 day Opus', limits.seven_day_opus),
    toWindow('seven-day-sonnet', '7 day Sonnet', limits.seven_day_sonnet),
    ...(limits.model_scoped ?? []).map((window, index) => (
      toWindow(`model-${index}`, `7 day ${window.display_name}`, window)
    )),
  ].filter((window): window is ProviderQuotaWindow => window !== null);
  const extra = limits.extra_usage;

  return {
    source: 'provider',
    fetchedAt,
    ...(response.subscription_type ? { plan: response.subscription_type } : {}),
    windows,
    ...(extra ? {
      extraUsage: {
        enabled: extra.is_enabled,
        ...(extra.utilization !== null
          ? { utilizationPercent: Math.max(0, Math.round(extra.utilization)) }
          : {}),
        ...(extra.used_credits !== null ? { usedCredits: extra.used_credits } : {}),
        ...(extra.monthly_limit !== null ? { monthlyLimit: extra.monthly_limit } : {}),
        ...(extra.currency ? { currency: extra.currency } : {}),
      },
    } : {}),
  };
}
