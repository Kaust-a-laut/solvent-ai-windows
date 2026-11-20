export {};

// Ambient types for the puter.js script (loaded externally). The API accepts
// either a plain prompt or an array of chat messages; responses vary by model,
// so they stay `unknown` and get narrowed at the call site.
interface PuterChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

interface PuterAI {
  chat: (
    message: string | PuterChatMessage[],
    options?: Record<string, unknown>
  ) => Promise<unknown>;
}

declare global {
  interface Window {
    puter: {
      ai: PuterAI;
    };
  }
  const puter: {
    ai: PuterAI;
  };
}
