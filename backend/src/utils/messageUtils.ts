import { ChatMessage } from '../types/ai';

/**
 * Normalizes chat messages to a standard format.
 * Converts 'model' role to 'assistant' for consistency across providers.
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => ({
    ...m,
    role: m.role === 'model' ? 'assistant' : m.role
  }));
}

/**
 * Normalizes messages for Ollama API format.
 * Handles image extraction from base64 data URLs.
 */
export function normalizeMessagesForOllama(messages: ChatMessage[]): Array<{ role: string; content: string; images?: string[] }> {
  return messages.map(m => {
    const msg: { role: string; content: string; images?: string[] } = {
      role: m.role,
      content: m.content
    };
    
    if (m.image) {
      const parsed = extractImageFromDataUrl(m.image);
      if (parsed) {
        msg.images = [parsed.data];
      }
    }
    
    return msg;
  });
}

/**
 * Normalizes messages for Gemini API format.
 * Converts to Gemini's role system ('user' or 'model').
 */
export function normalizeMessagesForGemini(messages: ChatMessage[]): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  return messages.map(m => ({
    role: (m.role === 'user' || m.role === 'system') ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));
}

/**
 * Extracts base64 image data from a data URL.
 * Returns null if the string is not a valid image data URL.
 */
export function extractImageFromDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  // indexOf instead of /^data:(.+);base64,(.+)$/: the greedy `.+` backtracks
  // across multi-MB payloads, `.` stops at the line breaks that wrapped
  // base64 often contains, and a `;base64,` inside the data shifted the split.
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const marker = dataUrl.indexOf(';base64,');
  if (marker <= 'data:'.length) return null;
  const mimeType = dataUrl.slice('data:'.length, marker);
  const data = dataUrl.slice(marker + ';base64,'.length).replace(/\s+/g, '');
  if (!data) return null;
  return { data, mimeType };
}
