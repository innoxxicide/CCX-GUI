/**
 * Types for the signed-in Claude account's rate-limit utilization, sourced from
 * Anthropic's OAuth usage endpoint via the Java backend
 * (ClaudeUsageLimitsService) and pushed to the webview as `onClaudeLimitsUpdate`.
 *
 * Field names mirror the endpoint response so the payload passes through the
 * backend untransformed. `utilization` is the percent of the window consumed
 * (0-100); the battery indicators display the remaining budget (100 - utilization).
 */

export interface UsageBucket {
  utilization: number;
  resets_at: string | null;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface ClaudeUsageBuckets {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  seven_day_cowork?: UsageBucket | null;
  extra_usage?: ExtraUsage | null;
}

export interface ClaudeLimitsState {
  available: boolean;
  /** Set when `available` is false: e.g. "no_oauth" (API-key user), "error". */
  reason?: string;
  fetchedAt?: number;
  subscriptionType?: string;
  usage?: ClaudeUsageBuckets;
}
