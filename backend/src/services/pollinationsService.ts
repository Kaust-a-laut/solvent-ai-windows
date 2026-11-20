import axios from 'axios';
import { logger } from '../utils/logger';

const MAX_PROMPT_CHARS = 1000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export class PollinationsService {
  private readonly baseUrl = 'https://image.pollinations.ai/prompt';

  /**
   * Generates an image using Pollinations.ai.
   * Returns a base64 string of the image.
   * @param prompt The prompt to generate the image from.
   * @param model Optional model specifier (though Pollinations auto-selects or uses query params, we'll append to prompt if needed or pass as query param).
   */
  async generateImage(prompt: string, _model?: string): Promise<{ base64: string, mimeType: string }> {
    try {
      // The prompt is the URL path — cap it so a long prompt can't produce
      // a URL the server (or a proxy) rejects.
      const boundedPrompt = String(prompt ?? '').slice(0, MAX_PROMPT_CHARS);
      logger.info(`[Pollinations] Generating image for prompt: "${boundedPrompt.slice(0, 80)}"`);

      const encodedPrompt = encodeURIComponent(boundedPrompt);
      // We can add parameters like width, height, model via query params if needed.
      // E.g. ?model=flux, ?width=1024, ?height=1024, ?nologo=true
      // Let's default to standard reliable settings.
      const url = `${this.baseUrl}/${encodedPrompt}?nologo=true`;

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: MAX_IMAGE_BYTES,
      });

      if (response.status !== 200) {
        throw new Error(`Pollinations API returned status: ${response.status}`);
      }

      // Pollinations usually returns JPEG; anything that isn't an image
      // (an HTML error page, JSON) must not be passed off as one.
      const contentType = String(response.headers['content-type'] ?? 'image/jpeg');
      if (!contentType.startsWith('image/')) {
        throw new Error(`Pollinations returned non-image content (${contentType.slice(0, 60)})`);
      }

      const base64 = Buffer.from(response.data).toString('base64');

      return {
        base64,
        mimeType: contentType
      };

    } catch (error: unknown) {
      const err = error as Error;
      logger.error(`[Pollinations] Error generating image: ${err.message}`);
      throw error;
    }
  }
}

export const pollinationsService = new PollinationsService();
