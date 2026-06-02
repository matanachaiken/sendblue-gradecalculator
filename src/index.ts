// index.ts — HTTP server that receives Sendblue webhook events
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { handleIncomingMessage } from './bot.js';

dotenv.config({ override: true });

const app = express();
app.use(express.json());

app.get('/', (_req: Request, res: Response) => res.send('grade-brain is running'));

// Dedup: Map of key → first-seen timestamp. Check and mark are separated so
// both happen synchronously before handleIncomingMessage is ever called.
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

// Rate limit: max 20 messages per phone number per minute.
const rateCounts = new Map<string, number>();
setInterval(() => rateCounts.clear(), 60_000);

app.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);

  const body = req.body as Record<string, unknown>;
  console.log('[webhook]', JSON.stringify({
    from_number: body.from_number,
    is_outbound: body.is_outbound,
    status: body.status,
    uuid: body.uuid,
    content: typeof body.content === 'string' ? body.content.slice(0, 50) : undefined,
  }));

  // Skip outbound delivery events (bot's own sent messages)
  if (body.is_outbound) return;

  // Skip status-update webhooks (delivered, read, etc.) — only process RECEIVED
  if (body.status && body.status !== 'RECEIVED') return;

  const content = body.content as string | undefined;
  const from_number = body.from_number as string | undefined;
  const media_url = body.media_url as string | undefined;
  const uuid = body.uuid as string | undefined;

  if (!from_number || (!content && !media_url)) return;
  if (from_number !== process.env.MY_PHONE) return;

  const count = (rateCounts.get(from_number) || 0) + 1;
  rateCounts.set(from_number, count);
  if (count > 20) {
    console.log('[webhook] rate limit hit for', from_number);
    return;
  }

  // Dedup: check both content fingerprint and UUID before marking either as seen.
  // Both checks happen synchronously here, before any async work begins.
  const contentKey = `${from_number}|${content}|${media_url || ''}`;
  const isContentDup = isSeen(contentKey);
  const isUuidDup = !!(uuid && isSeen(uuid));

  if (isContentDup || isUuidDup) {
    console.log('[webhook] duplicate dropped:', uuid || contentKey);
    return;
  }

  // Mark as seen synchronously — before the first await below.
  seenMessages.set(contentKey, Date.now());
  if (uuid) seenMessages.set(uuid, Date.now());

  try {
    await handleIncomingMessage(from_number, content || '', media_url || null);
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error handling message:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`grade-brain listening on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
