import { GoogleGenerativeAI, Tool } from '@google/generative-ai';
import { config } from '../config';
import { AIProvider, ChatMessage, CompletionOptions, ImageContent } from '../types/ai';
import { toolService } from './toolService';
import { getGeminiTools } from '../constants/tools';
import { logger } from '../utils/logger';
import { extractImageFromDataUrl, normalizeMessagesForGemini } from '../utils/messageUtils';

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '60000', 10);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

export class GeminiService implements AIProvider {
  readonly name = 'gemini';
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    if (config.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    }
  }

  private getGenAI(apiKey?: string): GoogleGenerativeAI {
    if (apiKey) return new GoogleGenerativeAI(apiKey);
    if (this.genAI) return this.genAI;
    throw new Error('Gemini API Key missing. Please provide it in settings or .env file.');
  }

  private getToolDefinitions() {
    return getGeminiTools();
  }

  async generateChatCompletion(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    const { model: modelName, shouldSearch, temperature = 0.7, maxTokens = 2048, apiKey, signal } = options;
    if (messages.length === 0) throw new Error('No messages provided');

    const genAI = this.getGenAI(apiKey);
    const tools = shouldSearch === false || options.jsonMode ? undefined : (this.getToolDefinitions() as Tool[]);

    const model = genAI.getGenerativeModel({
      model: modelName,
      ...(tools ? { tools } : {}),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(options.jsonMode ? { responseMimeType: 'application/json' } : {})
      }
    });

    // Use shared message normalization
    const history = normalizeMessagesForGemini(messages.slice(0, -1));
    const chat = model.startChat({ history });
    const lastMessage = messages[messages.length - 1]!.content;

    const MAX_TOOL_ITERATIONS = 10;
    try {
      let result = await withTimeout(chat.sendMessage(lastMessage), GEMINI_TIMEOUT_MS, 'Gemini chat');
      let response = await result.response;
      let calls = (response.candidates?.[0]?.content?.parts ?? []).filter(p => p.functionCall);
      let iteration = 0;

      // Handle Tool Calls (bounded loop; responds to ALL parallel functionCalls per turn)
      while (calls.length > 0) {
        if (signal?.aborted) throw new Error('Gemini request aborted');
        if (++iteration > MAX_TOOL_ITERATIONS) {
          throw new Error(`GeminiService exceeded max tool-calling iterations (${MAX_TOOL_ITERATIONS})`);
        }

        const responseParts: Array<Record<string, unknown>> = [];
        for (const part of calls) {
          const fnCall = part.functionCall!;
          const rawArgs = fnCall.args;
          const isPlainArgsObject =
            rawArgs != null &&
            typeof rawArgs === 'object' &&
            !Array.isArray(rawArgs);

          let toolResult: unknown;
          if (!isPlainArgsObject) {
            logger.warn(`[GeminiService] Invalid functionCall.args for ${fnCall.name}: ${typeof rawArgs}`);
            toolResult = {
              error: `Tool arguments must be a JSON object. Received ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}.`
            };
          } else {
            try {
              toolResult = await toolService.executeTool(
                fnCall.name,
                rawArgs as Record<string, unknown>
              );
            } catch (toolErr: unknown) {
              const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
              logger.error(`[GeminiService] Tool ${fnCall.name} failed: ${msg}`);
              toolResult = { error: msg };
            }
          }

          responseParts.push({
            functionResponse: {
              name: fnCall.name,
              response: { content: toolResult }
            }
          });

          // If it was a UI capture, inject the image into the next turn for visual reasoning
          const captureBase64 =
            fnCall.name === 'capture_ui' &&
            toolResult != null &&
            typeof toolResult === 'object' &&
            typeof (toolResult as { base64?: unknown }).base64 === 'string'
              ? (toolResult as { base64: string }).base64
              : undefined;
          if (captureBase64) {
            const imageInfo = extractImageFromDataUrl(captureBase64);
            if (imageInfo) {
              responseParts.push(
                { inlineData: { data: imageInfo.data, mimeType: imageInfo.mimeType } },
                { text: "Above is the screenshot I just captured. Analyze it to verify the UI state." }
              );
            }
          }
        }

        result = await withTimeout(
          chat.sendMessage(responseParts as unknown as Parameters<typeof chat.sendMessage>[0]),
          GEMINI_TIMEOUT_MS,
          'Gemini tool response'
        );
        response = await result.response;
        calls = (response.candidates?.[0]?.content?.parts ?? []).filter(p => p.functionCall);
      }

      return response.text();
    } catch (error: unknown) {
      const err = error as Error;
      logger.error(`[GeminiService] Error: ${err.message}`);
      throw error;
    }
  }

  async *generateChatStream(messages: ChatMessage[], options: CompletionOptions): AsyncGenerator<string> {
    const { model: modelName, temperature = 0.7, maxTokens = 2048, apiKey, signal } = options;
    if (signal?.aborted) return;

    const genAI = this.getGenAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      }
    });

    // Use shared message normalization
    const history = normalizeMessagesForGemini(messages.slice(0, -1));
    const chat = model.startChat({ history });
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) throw new Error('No messages provided');
    const lastMessage = lastMsg.content;
    const result = await withTimeout(chat.sendMessageStream(lastMessage), GEMINI_TIMEOUT_MS, 'Gemini stream');

    for await (const chunk of result.stream) {
      if (signal?.aborted) break;
      const text = chunk.text();
      if (text) yield text;
    }
  }

  async generateVisionContent(prompt: string, imageParts: ImageContent[], options?: CompletionOptions) {
    const { model: modelName, temperature = 0.7, maxTokens = 2048, apiKey } = options || {};
    const genAI = this.getGenAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName || 'gemini-3-flash-preview',
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      }
    });
    const geminiParts = imageParts.map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType } }));
    const result = await withTimeout(model.generateContent([prompt, ...geminiParts]), GEMINI_TIMEOUT_MS, 'Gemini vision');
    const response = await result.response;
    return response.text();
  }

  vision = this.generateVisionContent;

  async generateImage(prompt: string, modelName: string = 'imagen-3.0-generate-001', apiKey?: string) {
    const genAI = this.getGenAI(apiKey);
    logger.info(`[Gemini] Requesting image generation with model: ${modelName}`);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await withTimeout(model.generateContent(prompt), GEMINI_TIMEOUT_MS, 'Gemini image');
    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find(part => part.inlineData);

    if (imagePart && imagePart.inlineData) {
      logger.info(`[Gemini] Image generated successfully. MIME: ${imagePart.inlineData.mimeType}`);
      return {
        base64: imagePart.inlineData.data,
        mimeType: imagePart.inlineData.mimeType
      };
    }
    logger.error(`[Gemini] Image generation failed. Response parts: ${JSON.stringify(parts)}`);
    throw new Error('Image generation failed or model not supported. Ensure you have access to Imagen 3 API.');
  }
}
