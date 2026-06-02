// sendblue.ts — Wrapper for the Sendblue iMessage API
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ override: true });
const SENDBLUE_URL = 'https://api.sendblue.co/api/send-message';
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
