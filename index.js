// index.js — HTTP server that receives Sendblue webhook events
import express from 'express';
import dotenv from 'dotenv';
import { handleIncomingMessage } from './bot.js';

dotenv.config({ override: true });

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('grade-brain is running'));

// Dedup cache — keyed by UUID when present, otherwise by "from+content+second".
// Sendblue fires the webhook for both inbound messages AND outbound delivery events,
// and sometimes fires the same inbound webhook twice with different UUIDs.
const seen = new Set();
setInterval(() => seen.clear(), 60_000);

// Rate limit: max 20 messages per phone number per minute.
const rateCounts = new Map();
setInterval(() => rateCounts.clear(), 60_000);

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  // Log the full body so we can diagnose any unexpected webhook shapes
  const body = req.body;
  console.log('[webhook]', JSON.stringify({
    from_number: body.from_number,
    is_outbound: body.is_outbound,
    status: body.status,
    uuid: body.uuid,
    content: body.content?.slice(0, 50),
  }));

  // Skip outbound delivery events (bot's own sent messages)
  if (body.is_outbound) return;

  // Skip status-update webhooks (delivered, read, etc.) — only process RECEIVED
  if (body.status && body.status !== 'RECEIVED') return;

  const { content, from_number, media_url, uuid } = body;

  if (!from_number || (!content && !media_url)) return;
  if (from_number !== process.env.MY_PHONE) return;

  const count = (rateCounts.get(from_number) || 0) + 1;
  rateCounts.set(from_number, count);
  if (count > 20) {
    console.log('[webhook] rate limit hit for', from_number);
    return;
  }

  // Dedup: check both UUID and content fingerprint.
  // Sendblue sometimes fires the same message twice with different UUIDs,
  // so the content key catches that case even when UUIDs differ.
  const contentKey = `${from_number}|${content}|${media_url || ''}|${Math.floor(Date.now() / 10000)}`;
  if (seen.has(contentKey) || (uuid && seen.has(uuid))) {
    console.log('[webhook] duplicate dropped:', uuid || contentKey);
    return;
  }
  seen.add(contentKey);
  if (uuid) seen.add(uuid);

  try {
    await handleIncomingMessage(from_number, content || '', media_url || null);
  } catch (err) {
    console.error('Error handling message:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`grade-brain listening on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
