// sendblue.ts — Wrapper for the Sendblue iMessage API
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ override: true });
const SENDBLUE_URL = 'https://api.sendblue.co/api/send-message';
const SENDBLUE_MESSAGES_URL = 'https://api.sendblue.com/api/v2/messages';
/**
 * Send an iMessage via the Sendblue API.
 *
 * @param to   - Recipient phone number in E.164 format (e.g. +12025551234)
 * @param text - Message text to send
 */
export async function sendMessage(to, text) {
    // TEST_MODE: print to console instead of calling the API
    if (process.env.TEST_MODE === 'true') {
        console.log(`\nBot: ${text}`);
        return;
    }
    try {
        await axios.post(SENDBLUE_URL, {
            number: to,
            from_number: process.env.SENDBLUE_NUMBER,
            content: text,
        }, {
            headers: {
                'sb-api-key-id': process.env.SENDBLUE_API_KEY,
                'sb-api-secret-key': process.env.SENDBLUE_API_SECRET,
                'Content-Type': 'application/json',
            },
        });
    }
    catch (err) {
        // Log the error but don't crash the bot
        const e = err;
        console.error('Sendblue error:', e.response?.data || e.message);
        throw err;
    }
}
/**
 * Fetch recent messages from Sendblue's v2 API.
 * Used by polling mode — the bot calls this instead of waiting for webhooks.
 *
 * @param number - E.164 phone number to fetch history for (MY_PHONE)
 * @param limit  - Max messages to return
 * @param after  - ISO timestamp — only return messages sent after this time
 */
export async function getMessages(number, limit = 20) {
    if (process.env.TEST_MODE === 'true')
        return [];
    try {
        const params = { number, limit };
        const res = await axios.get(SENDBLUE_MESSAGES_URL, {
            params,
            headers: {
                'sb-api-key-id': process.env.SENDBLUE_API_KEY,
                'sb-api-secret-key': process.env.SENDBLUE_API_SECRET,
            },
            timeout: 10_000,
        });
        const data = res.data;
        return Array.isArray(data) ? data : (data.messages ?? []);
    }
    catch (err) {
        const e = err;
        console.error('[poll] getMessages error:', e.response?.data || e.message);
        return [];
    }
}
