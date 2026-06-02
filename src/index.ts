// index.ts — Bot entry point. Supports two intake modes:
//
//   Polling (default): the bot calls Sendblue's GET /api/v2/messages every
//     POLL_INTERVAL ms and processes any new inbound messages itself.
//     No public URL or ngrok required.
//
//   Webhook: Sendblue pushes messages to the Express server. Requires a
//     public HTTPS URL (ngrok or a deployed host) set in the Sendblue dashboard.
//
// Set POLLING_MODE=false in .env to use webhook mode instead.

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { handleIncomingMessage } from './bot.js';
import { getMessages } from './sendblue.js';

dotenv.config({ override: true });

const POLLING_MODE = process.env.POLLING_MODE !== 'false'; // default: true
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000', 10);

// ── Shared dedup state ───────────────────────────────────────────────────────

const seenMessages = new Map<string, number>();
const DEDUP_TTL_MS = 30_000;
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [k, t] of seenMessages) {
    if (t < cutoff) seenMessages.delete(k);
  }
}, DEDUP_TTL_MS);

function isSeen(key: string): boolean {
  const t = seenMessages.get(key);
  return t !== undefined && Date.now() - t < DEDUP_TTL_MS;
}

function markSeen(...keys: string[]): void {
  const now = Date.now();
  for (const k of keys) seenMessages.set(k, now);
}

// Rate limit: max 20 messages per phone number per minute.
const rateCounts = new Map<string, number>();
setInterval(() => rateCounts.clear(), 60_000);

function isRateLimited(phone: string): boolean {
  const count = (rateCounts.get(phone) || 0) + 1;
  rateCounts.set(phone, count);
  if (count > 20) { console.log('[rate] limit hit for', phone); return true; }
  return false;
}

// ── Polling loop ─────────────────────────────────────────────────────────────

function startPolling(): void {
  const myPhone = process.env.MY_PHONE;
  if (!myPhone) { console.error('[poll] MY_PHONE not set'); return; }

  // Only process messages that arrive after the bot starts.
  let lastSeenAt = new Date().toISOString();
  console.log(`[poll] polling every ${POLL_INTERVAL}ms`);

  setInterval(async () => {
    const messages = await getMessages(myPhone, 20);

    // Only inbound RECEIVED messages, oldest first
    const fresh = messages
      .filter(m =>
        !m.is_outbound &&
        m.status === 'RECEIVED' &&
        m.date_sent > lastSeenAt &&
        (!!m.content || !!m.media_url),
      )
      .sort((a, b) => a.date_sent.localeCompare(b.date_sent));

    for (const msg of fresh) {
      const contentKey = `${msg.from_number}|${msg.content ?? ''}|${msg.media_url ?? ''}`;

      if (isSeen(msg.uuid) || isSeen(contentKey)) {
        console.log('[poll] duplicate dropped:', msg.uuid);
        continue;
      }
      if (isRateLimited(msg.from_number)) continue;

      // Mark seen synchronously before any await
      markSeen(msg.uuid, contentKey);

      console.log('[poll]', JSON.stringify({
        from: msg.from_number,
        date: msg.date_sent,
        content: (msg.content ?? '').slice(0, 50),
      }));

      try {
        await handleIncomingMessage(msg.from_number, msg.content ?? '', msg.media_url ?? null);
      } catch (err) {
        const e = err as { message?: string };
        console.error('[poll] handler error:', e.message);
      }

      lastSeenAt = msg.date_sent;
    }
  }, POLL_INTERVAL);
}

// ── Express server (webhook handler + health check) ──────────────────────────

const app = express();
app.use(express.json());
app.get('/', (_req: Request, res: Response) => res.send('grade-brain is running'));

async function handleWebhook(req: Request, res: Response) {
  res.sendStatus(200);

  const body = req.body as Record<string, unknown>;
  console.log('[webhook]', JSON.stringify({
    from_number: body.from_number,
    is_outbound: body.is_outbound,
    status: body.status,
    uuid: body.uuid,
    content: typeof body.content === 'string' ? body.content.slice(0, 50) : undefined,
  }));

  if (body.is_outbound) return;
  if (body.status && body.status !== 'RECEIVED') return;

  const content     = body.content     as string | undefined;
  const from_number = body.from_number as string | undefined;
  const media_url   = body.media_url   as string | undefined;
  const uuid        = body.uuid        as string | undefined;

  if (!from_number || (!content && !media_url)) return;
  if (from_number !== process.env.MY_PHONE) return;
  if (isRateLimited(from_number)) return;

  const contentKey   = `${from_number}|${content ?? ''}|${media_url ?? ''}`;
  const isContentDup = isSeen(contentKey);
  const isUuidDup    = !!(uuid && isSeen(uuid));

  if (isContentDup || isUuidDup) {
    console.log('[webhook] duplicate dropped:', uuid || contentKey);
    return;
  }

  markSeen(contentKey, ...(uuid ? [uuid] : []));

  try {
    await handleIncomingMessage(from_number, content ?? '', media_url ?? null);
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error handling message:', e.message);
  }
}

// Mount the webhook on both '/' and '/webhook' so it works regardless of how
// the Sendblue dashboard webhook URL is configured.
app.post('/', handleWebhook);
app.post('/webhook', handleWebhook);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (POLLING_MODE) {
    console.log('grade-brain running in polling mode (no ngrok needed)');
    console.log(`Health check: http://localhost:${PORT}/`);
    startPolling();
  } else {
    console.log(`grade-brain listening on port ${PORT} (webhook mode)`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  }
});
