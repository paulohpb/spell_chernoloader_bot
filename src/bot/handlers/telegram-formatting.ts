/**
 * @module handlers/telegram-formatting
 *
 * Shared text-processing helpers used by multiple command handlers.
 * Kept in one place so that identical logic (URL extraction,
 * MarkdownV2 escaping) is never copy-pasted into a second file.
 */

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the first HTTP/HTTPS URL found in a string.
 *
 * @param text - Arbitrary text that may contain zero or more URLs.
 * @returns The first matched URL, or `null` when none is present.
 */
export const extractUrl = (text: string): string | null => {
  const match = text.match(/https?:\/\/[^\s\]<>"]+/);
  return match ? match[0] : null;
};

// ---------------------------------------------------------------------------
// MarkdownV2 escaping
// ---------------------------------------------------------------------------

/**
 * Escapes every character that Telegram's MarkdownV2 parser treats as
 * special.  Apply this to any user-supplied or externally-sourced text
 * before embedding it in a MarkdownV2 reply.
 *
 * Required escape set (Telegram docs):
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * @param text - Raw string to escape.
 * @returns The escaped string, safe for MarkdownV2 `parse_mode`.
 */
export const escapeMarkdownV2 = (text: string): string =>
  text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
