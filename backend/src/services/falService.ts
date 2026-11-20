import axios from 'axios';
import { logger } from '../utils/logger';
import { safeAxiosGet } from '../utils/urlSafety';

const QUEUE_BASE = 'https://queue.fal.run/fal-ai/flux/schnell/requests';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface FalImageResult {
  images?: Array<{ url?: string }>;
}

/**
 * FAL.ai image generation service.
 * Uses the FAL.ai REST API (fal-ai/flux/schnell) to generate images from text prompts.
 * Requires a FAL_API_KEY — get yours at https://fal.ai/
 */
export class FalService {
  private readonly apiUrl = 'https://fal.run/fal-ai/flux/schnell';

  /**
   * Generate an image using FAL.ai Flux Schnell.
   * @param prompt  Text description of the image to generate.
   * @param apiKey  FAL.ai API key.
   * @returns base64-encoded PNG image.
   */
  async generateImage(prompt: string, apiKey: string): Promise<{ base64: string; mimeType: string }> {
    logger.debug(`[FAL] Generating image: "${prompt.slice(0, 80)}..."`);
    const auth = { Authorization: `Key ${apiKey}` };

    // Step 1: Submit. fal.run normally answers synchronously with the result;
    // a queued submission returns a request_id instead.
    const submitRes = await axios.post(
      this.apiUrl,
      { prompt, num_inference_steps: 4, image_size: 'landscape_4_3' },
      {
        headers: { ...auth, 'Content-Type': 'application/json' },
        timeout: 120_000,
      },
    );

    let imageUrl: string | null = (submitRes.data as FalImageResult)?.images?.[0]?.url ?? null;

    if (!imageUrl && typeof submitRes.data?.request_id === 'string') {
      const requestId = encodeURIComponent(submitRes.data.request_id);
      // The bare /requests/{id} endpoint returns 400 while the job is still
      // queued — poll /status until COMPLETED, then fetch the result once.
      const statusUrl = `${QUEUE_BASE}/${requestId}/status`;
      const resultUrl = `${QUEUE_BASE}/${requestId}`;

      let completed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await axios.get(statusUrl, { headers: auth, timeout: 10_000 });
        const status = String(pollRes.data?.status ?? '');
        if (status === 'COMPLETED') {
          completed = true;
          break;
        }
        if (status === 'FAILED' || status === 'ERROR') {
          throw new Error(`FAL generation failed: ${pollRes.data?.error ?? status}`);
        }
      }
      if (!completed) throw new Error('FAL.ai generation timed out in queue');

      // The result body is the model output itself (`{ images: [...] }`) —
      // there is no `.response` wrapper.
      const resultRes = await axios.get(resultUrl, { headers: auth, timeout: 15_000 });
      imageUrl = (resultRes.data as FalImageResult)?.images?.[0]?.url ?? null;
    }

    if (!imageUrl) throw new Error('FAL.ai did not return an image URL');

    // Step 2: Fetch the image through the SSRF guard (the URL comes from a
    // third-party response) with a size cap.
    const imgRes = await safeAxiosGet(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_IMAGE_BYTES,
      maxHops: 3,
    });
    const contentType = String(imgRes.headers['content-type'] ?? 'image/jpeg');
    if (!contentType.startsWith('image/')) {
      throw new Error(`FAL.ai image URL returned non-image content (${contentType.slice(0, 60)})`);
    }
    const base64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');

    logger.info('[FAL] Image generation complete');
    return { base64, mimeType: contentType };
  }
}

export const falService = new FalService();
