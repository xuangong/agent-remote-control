# Seamless workspace access

Approved behavior: render this browser's last confirmed workspace immediately for a rolling 24 hours. Every successful background authorization renews that window. Cached data is presentation only; business requests and subscriptions wait for authorization, and message delivery waits for session readiness. Keep drafts and mounted UI through transient recovery. Returning browsers may follow the existing Gateway authorization flow automatically once, without loops or undoing sign-out.

1. Add bounded, account-scoped display storage and rolling access metadata; clear on sign-out/account change.
2. Separate Gateway display access from API readiness, bound each request, retry transient failures, and preserve mounted content.
3. Gate business transport during recovery; restore the last timeline as presentation without seeding authoritative cursors, interactions, or outbox.
4. Preload the application alongside access checking; use a quiet recovery indicator after the foreground grace period.
5. Verify storage/expiry, auth races, silent return, actual business transport gating, and draft continuity. Run build, typecheck, targeted regressions and compatibility checks. Do not deploy or merge as part of this implementation.
