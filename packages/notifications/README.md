# @seaking/notifications

Transactional email via Resend.

## Phase 1A

Stub `sendNotification({ to, subject, html })`. Real templates and per-event dispatchers come in Phase 1H when the notification matrix from `01_FUNCTIONAL_SPEC.md §Notifications` lands.

## Environment

- `RESEND_API_KEY` — required before any send call
- `NOTIFICATIONS_FROM_EMAIL` — optional default From address (defaults to `noreply@seakingcapital.com`)

Special recipient addresses from the spec:
- `overadvanced@seakingcapital.com` — Over Advanced alerts, cancellation-with-balance alerts
- `advancerequest@seakingcapital.com` — Client Advance Request submissions
