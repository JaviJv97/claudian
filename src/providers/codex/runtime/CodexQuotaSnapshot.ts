import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../core/runtime/types';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix epoch seconds. */
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
}

export interface CodexAccountRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits: unknown;
}

function getWindowLabel(durationMinutes: number | null, fallback: string): string {
  if (durationMinutes === 300) return '5 hour';
  if (durationMinutes === 10_080) return '7 day';
  if (durationMinutes !== null) return `${durationMinutes} min`;
  return fallback;
}

function toWindow(
  fallbackId: string,
  fallbackLabel: string,
  value: CodexRateLimitWindow | null,
): ProviderQuotaWindow | null {
  if (!value || !Number.isFinite(value.usedPercent)) return null;
  const id = value.windowDurationMins === 300
    ? 'five-hour'
    : value.windowDurationMins === 10_080
      ? 'seven-day'
      : fallbackId;
  return {
    id,
    label: getWindowLabel(value.windowDurationMins, fallbackLabel),
    utilizationPercent: Math.max(0, Math.round(value.usedPercent)),
    ...(value.resetsAt !== null ? { resetsAt: value.resetsAt * 1000 } : {}),
  };
}

export function mapCodexRateLimitsToQuotaSnapshot(
  response: CodexAccountRateLimitsResponse,
  fetchedAt = Date.now(),
): ProviderQuotaSnapshot {
  const limits = response.rateLimits;
  const windows = [
    toWindow('primary', 'Primary', limits.primary),
    toWindow('secondary', 'Secondary', limits.secondary),
  ].filter((window): window is ProviderQuotaWindow => window !== null);

  return {
    source: 'provider',
    fetchedAt,
    ...(limits.planType ? { plan: limits.planType } : {}),
    windows,
    ...(windows.length === 0
      ? { unavailableReason: 'Codex account quota windows are unavailable.' }
      : {}),
  };
}
