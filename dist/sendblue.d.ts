export interface SendblueMessage {
    uuid: string;
    content: string | null;
    is_outbound: boolean;
    status: string;
    date_sent: string;
    from_number: string;
    number: string;
    media_url?: string | null;
}
/**
 * Send an iMessage via the Sendblue API.
 *
 * @param to   - Recipient phone number in E.164 format (e.g. +12025551234)
 * @param text - Message text to send
 */
export declare function sendMessage(to: string, text: string): Promise<void>;
/**
 * Fetch recent messages from Sendblue's v2 API.
 * Used by polling mode — the bot calls this instead of waiting for webhooks.
 *
 * @param number - E.164 phone number to fetch history for (MY_PHONE)
 * @param limit  - Max messages to return
 * @param after  - ISO timestamp — only return messages sent after this time
 */
export declare function getMessages(number: string, limit?: number): Promise<SendblueMessage[]>;
