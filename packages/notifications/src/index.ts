/**
 * Resend-based email dispatch. Phase 1A: stub only; full templates and
 * dispatch arrive in Phase 1H.
 *
 * Resend is lazily instantiated so apps don't need RESEND_API_KEY at build
 * time — only when a notification actually fires.
 */

import { Resend } from 'resend';

export interface NotificationRequest {
  to: string | string[];
  subject: string;
  /** HTML body. */
  html: string;
  /** Optional plain-text fallback. */
  text?: string;
  /** From address (defaults to NOTIFICATIONS_FROM_EMAIL if set). */
  from?: string;
}

let cachedClient: Resend | null = null;

function getClient(): Resend {
  if (cachedClient) return cachedClient;
  const apiKey = process.env['RESEND_API_KEY'];
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not set — cannot send notifications');
  }
  cachedClient = new Resend(apiKey);
  return cachedClient;
}

export async function sendNotification(req: NotificationRequest): Promise<void> {
  const from = req.from ?? process.env['NOTIFICATIONS_FROM_EMAIL'] ?? 'noreply@seakingcapital.com';
  const resend = getClient();
  const emailPayload: {
    from: string;
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
  } = {
    from,
    to: req.to,
    subject: req.subject,
    html: req.html,
  };
  if (req.text !== undefined) {
    emailPayload.text = req.text;
  }
  const result = await resend.emails.send(emailPayload);
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
}
