export interface QuotaProfile { sessionBytes: number; hostBytes: number }
export const QUOTA_PROFILES: { default: QuotaProfile; tinySession: QuotaProfile; tinyHost: QuotaProfile };
export function bigToolOutputPrompt(mebibytes: number, options?: { word?: string }): string;
