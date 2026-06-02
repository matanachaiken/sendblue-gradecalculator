/**
 * Send an iMessage via the Sendblue API.
 *
 * @param to   - Recipient phone number in E.164 format (e.g. +12025551234)
 * @param text - Message text to send
 */
export declare function sendMessage(to: string, text: string): Promise<void>;
