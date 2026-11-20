export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'model';
  content: string;
  model?: string;
  image?: string | null;
  thinking?: string;
  isGeneratedImage?: boolean;
  imageUrl?: string;
  /** Epoch ms when the message was created on the frontend. */
  createdAt?: number;
}
