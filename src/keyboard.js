import { randomBytes } from 'node:crypto';
import { isRecord } from './config.js';
import { safeLink } from './format.js';

export const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
export function normalizeButtons(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error('buttons must contain at most 10 rows');
  return value.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 8) throw new Error('Each button row must contain 1 to 8 buttons');
    return row.map((button) => {
      if (!isRecord(button) || Object.keys(button).some((key) => !['text', 'url', 'callbackData', 'style'].includes(key)) ||
          typeof button.text !== 'string' || !button.text.trim() || button.text.length > 128 || /[\x00-\x1f\x7f]/.test(button.text)) throw new Error('Invalid button label or fields');
      if ((button.url !== undefined) === (button.callbackData !== undefined)) throw new Error('A button requires exactly one of url or callbackData');
      if (button.url !== undefined && !safeLink(button.url)) throw new Error('Button URL must be an HTTP(S) URL without credentials');
      if (button.callbackData !== undefined && (typeof button.callbackData !== 'string' || !button.callbackData.trim() ||
          Buffer.byteLength(button.callbackData) > 256 || /[\x00-\x1f\x7f]/.test(button.callbackData))) throw new Error('Invalid callback data (maximum 256 UTF-8 bytes)');
      const style = button.style ?? 'base';
      if (!['base', 'primary', 'attention'].includes(style)) throw new Error('Invalid button style');
      return { text: button.text, ...(button.url !== undefined ? { url: button.url } : { callbackData: button.callbackData }), style };
    });
  });
}
export function prepareKeyboard(buttons, ownerId, now = Date.now()) {
  const normalized = normalizeButtons(buttons);
  if (normalized === undefined) return {};
  const callbacks = [];
  const keyboard = normalized.map((row) => row.map((button) => {
    if (button.url !== undefined) return button;
    const token = `ocw:${randomBytes(18).toString('base64url')}`;
    callbacks.push({ token, data: button.callbackData, ownerId, expiresAt: now + CALLBACK_TTL_MS });
    return { ...button, callbackData: token };
  }));
  return { keyboard, callbacks };
}
