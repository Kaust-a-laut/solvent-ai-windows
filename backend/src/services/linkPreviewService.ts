import { safeAxiosGet, UrlSafetyError } from '../utils/urlSafety';
import { logger } from '../utils/logger';

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

const HEAD_BUDGET = 64 * 1024; // 64KB is plenty for <head>
const FETCH_TIMEOUT_MS = 8000;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));

const META_TAG = /<meta\b[^>]*>/gi;
const ATTR_RE = /(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_TAG = /<link\b[^>]*>/gi;

const parseAttrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[key] = value;
  }
  return out;
};

const absolutize = (base: URL, ref: string | undefined): string | undefined => {
  if (!ref) return undefined;
  try { return new URL(ref, base).toString(); } catch { return undefined; }
};

export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error('Invalid URL'); }

  try {
    const response = await safeAxiosGet(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SolventAI-LinkPreview/1.0)',
      },
      responseType: 'text',
      maxHops: 5,
      maxContentLength: HEAD_BUDGET * 2, // axios uses bytes; double-budget gives slack for headers
      transformResponse: [(data) => data], // keep raw string
    });

    let html = typeof response.data === 'string' ? response.data : String(response.data);
    // Only need <head>; chop the body to keep parsing fast and bounded.
    const headEnd = html.search(/<\/head>/i);
    if (headEnd !== -1) html = html.slice(0, headEnd + 7);
    if (html.length > HEAD_BUDGET) html = html.slice(0, HEAD_BUDGET);

    const og: Record<string, string> = {};
    const tw: Record<string, string> = {};
    const named: Record<string, string> = {};

    let mt: RegExpExecArray | null;
    while ((mt = META_TAG.exec(html)) !== null) {
      const attrs = parseAttrs(mt[0]);
      const property = attrs['property'] || '';
      const name = attrs['name'] || '';
      const content = attrs['content'];
      if (!content) continue;
      if (property.startsWith('og:')) og[property.slice(3)] = content;
      else if (name.startsWith('twitter:')) tw[name.slice(8)] = content;
      else if (name) named[name.toLowerCase()] = content;
    }

    let favicon: string | undefined;
    let lt: RegExpExecArray | null;
    while ((lt = LINK_TAG.exec(html)) !== null) {
      const attrs = parseAttrs(lt[0]);
      const rel = (attrs['rel'] || '').toLowerCase();
      if (rel.includes('icon') && attrs['href']) {
        favicon = attrs['href'];
        if (rel.includes('shortcut') || rel === 'icon') break;
      }
    }
    if (!favicon) favicon = `${parsedUrl.protocol}//${parsedUrl.host}/favicon.ico`;

    let title: string | undefined = og['title'] || tw['title'];
    if (!title) {
      const tm = TITLE_RE.exec(html);
      if (tm && tm[1]) title = tm[1].trim();
    }

    const description = og['description'] || tw['description'] || named['description'];
    const image = og['image'] || og['image:secure_url'] || tw['image'] || tw['image:src'];
    const siteName = og['site_name'] || named['application-name'];

    return {
      url: parsedUrl.toString(),
      title: title ? decodeEntities(title).slice(0, 240) : undefined,
      description: description ? decodeEntities(description).slice(0, 600) : undefined,
      image: absolutize(parsedUrl, image),
      siteName: siteName ? decodeEntities(siteName).slice(0, 120) : undefined,
      favicon: absolutize(parsedUrl, favicon),
    };
  } catch (err) {
    if (err instanceof UrlSafetyError) {
      throw new Error('Cannot fetch private/local addresses');
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[linkPreview] fetch failed for ${parsedUrl.host}: ${msg}`);
    throw new Error(`Could not fetch preview: ${msg}`);
  }
}
