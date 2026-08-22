/* Short-lived tickets for page source that arrives from somewhere other than
   this app's own origin — the "send page to particle" bookmarklet, clicked on
   an archive.today tab after a human cleared the captcha. The token is the
   whole authorisation: unguessable, single use, and it expires. */
import { randomBytes } from 'node:crypto';

const TTL_MS = 15 * 60 * 1000;
const MAX_TICKETS = 32;

const tickets = new Map();

function sweep() {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(token);
  }
  while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
}

export function createTicket(url) {
  sweep();
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  tickets.set(token, { url, expiresAt, status: 'pending', article: null, error: null });
  return { token, url, expires_at: new Date(expiresAt).toISOString() };
}

/* Claim the ticket for delivery. Returns null once it is spent or expired, so a
   replayed bookmarklet click cannot re-run an extraction. */
export function claimTicket(token) {
  sweep();
  const ticket = tickets.get(String(token || ''));
  if (!ticket || ticket.status !== 'pending') return null;
  ticket.status = 'claimed';
  return ticket;
}

export function settleTicket(token, { article, error }) {
  const ticket = tickets.get(String(token || ''));
  if (!ticket) return;
  ticket.status = error ? 'error' : 'ready';
  ticket.article = article || null;
  ticket.error = error || null;
  // A failed delivery is worth retrying from the same bookmarklet click.
  if (error) ticket.status = 'pending';
}

export function readTicket(token) {
  sweep();
  const ticket = tickets.get(String(token || ''));
  if (!ticket) return { status: 'expired' };
  return { status: ticket.status, article: ticket.article, error: ticket.error };
}
