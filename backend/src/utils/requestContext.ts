import { AsyncLocalStorage } from 'async_hooks';

export interface PreviewConsoleEntry {
  level: string;
  message: string;
  timestamp: number;
}

export interface PreviewSelectedElement {
  tag: string;
  id?: string;
  classes: string[];
  text: string;
}

export interface PreviewState {
  url?: string | null;
  bodyHash?: string | null;
  consoleBuffer?: PreviewConsoleEntry[];
  selectedElement?: PreviewSelectedElement | null;
}

export interface RequestContext {
  previewState?: PreviewState;
  projectRoot?: string;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

export function getPreviewState(): PreviewState | undefined {
  return requestContextStore.getStore()?.previewState;
}
