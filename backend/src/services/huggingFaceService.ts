import axios from 'axios';
import { logger } from '../utils/logger';
import { pollinationsService } from './pollinationsService';

// `owner/name` with no path separators, dots-only segments, or query chars —
// the model id is interpolated into a URL that carries the Bearer token.
const HF_MODEL_ID = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export class HuggingFaceService {
  // api-inference.huggingface.co was retired (410 Gone); the HF Inference
  // provider now lives behind the router.
  private readonly baseUrl = 'https://router.huggingface.co/hf-inference/models/';
  // A very stable model that is almost always available on the free API
  private readonly defaultModel = 'prompthero/openjourney';

  /**
   * Generates an image using Hugging Face Inference API.
   * @param prompt The prompt to generate the image from.
   * @param apiKey Your Hugging Face API Token.
   * @param model Optional model override.
   */
  async generateImage(prompt: string, apiKey: string, model: string = this.defaultModel): Promise<{ base64: string, mimeType: string }> {
    try {
      const cleanKey = apiKey?.trim();
      const targetModel = model || this.defaultModel;
      if (!HF_MODEL_ID.test(targetModel) || targetModel.split('/').some(seg => /^\.+$/.test(seg))) {
        throw new Error(`Invalid Hugging Face model id: ${targetModel.slice(0, 80)}`);
      }
      const url = `${this.baseUrl}${targetModel}`;
      logger.info(`[HuggingFace] Requesting image: ${url}`);

      const response = await axios.post(
        url,
        { inputs: prompt },
        {
          headers: {
            Authorization: `Bearer ${cleanKey}`,
            'Content-Type': 'application/json',
            Accept: 'image/png',
          },
          responseType: 'arraybuffer',
          timeout: 90000,
          maxContentLength: 25 * 1024 * 1024,
          maxRedirects: 0,
        }
      );

      logger.info(`[HuggingFace] Response received. Status: ${response.status}`);

      if (response.status !== 200) {
        throw new Error(`Hugging Face API returned status: ${response.status}`);
      }

      const contentType = String(response.headers['content-type'] ?? '');
      if (!contentType.startsWith('image/')) {
        // JSON (errors, "model loading", or a text model's output) must not be
        // base64-encoded and handed back as a PNG.
        let detail = contentType || 'unknown content type';
        if (contentType.includes('json')) {
          try {
            const json = JSON.parse(Buffer.from(response.data).toString()) as { error?: unknown };
            if (json.error) detail = String(json.error);
          } catch { /* keep content-type detail */ }
        }
        throw new Error(`HF API did not return an image: ${detail.slice(0, 200)}`);
      }

      const base64 = Buffer.from(response.data).toString('base64');
      return { base64, mimeType: contentType };

    } catch (error: unknown) {
      const err = error as Error;
      logger.error(`[HuggingFace] Primary generation failed: ${err.message}. Initiating internal fallback.`);

      // Internal Fallback to Pollinations to ensure UI consistency
      try {
        return await pollinationsService.generateImage(prompt);
      } catch {
        throw new Error(`Hugging Face failed (${err.message}) and fallback also failed.`);
      }
    }
  }
}

export const huggingFaceService = new HuggingFaceService();
