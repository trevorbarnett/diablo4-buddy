import Anthropic from '@anthropic-ai/sdk';

const BASE = 'https://www.wowhead.com/diablo-4';
const client = new Anthropic();

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchPage(path: string): Promise<string> {
  const url = path.startsWith('http') ? path : `${BASE}/${path}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; D4Advisor/1.0)',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) throw new Error(`Wowhead fetch failed: ${resp.status} ${url}`);
  return stripHtml(await resp.text());
}

export interface WowheadResult {
  name: string;
  type: 'item' | 'aspect' | 'skill' | 'other';
  description: string;
  url: string;
}

// Use Claude to extract structured info from a raw Wowhead page
async function extractWithClaude(text: string, query: string): Promise<WowheadResult[]> {
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `You are a Diablo 4 database parser. Extract structured results from Wowhead page text.
Return a JSON array of matches relevant to the user's query.
Each entry: { "name": "...", "type": "item|aspect|skill|other", "description": "one sentence", "url": "" }
If nothing relevant found, return [].
OUTPUT: Valid JSON array only, no markdown.`,
    messages: [{
      role: 'user',
      content: `Query: "${query}"\n\nPage text (truncated):\n${text.slice(0, 3000)}`,
    }],
  });

  const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '[]';
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')) as WowheadResult[];
  } catch {
    return [];
  }
}

// Fetch a known Wowhead page path and return parsed results
export async function fetchWowheadPage(path: string, query: string): Promise<WowheadResult[]> {
  const text = await fetchPage(path);
  return extractWithClaude(text, query);
}

// Search Wowhead — tries the search page (mostly JS-rendered, may return little),
// then falls back to Claude's knowledge via the query alone
export async function searchWowhead(query: string): Promise<{ results: WowheadResult[]; source: string }> {
  // Try the opensearch endpoint — returns JSON for some queries
  const openSearchUrl = `${BASE}/search?q=${encodeURIComponent(query)}&opensearch=true`;
  try {
    const resp = await fetch(openSearchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; D4Advisor/1.0)', 'Accept': 'application/json, text/html' },
    });
    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      // OpenSearch returns [query, [names], [descs], [urls]]
      const data = await resp.json() as [string, string[], string[], string[]];
      if (Array.isArray(data) && data.length >= 4) {
        const results: WowheadResult[] = data[1].map((name, i) => ({
          name,
          type: 'other' as const,
          description: data[2][i] ?? '',
          url: data[3][i] ?? '',
        }));
        return { results, source: 'opensearch' };
      }
    }

    // HTML response — strip and have Claude parse
    const html = await resp.text();
    const text = stripHtml(html);
    const results = await extractWithClaude(text, query);
    return { results, source: 'html-parse' };
  } catch {
    // Network error — use Claude knowledge fallback
    const results = await claudeKnowledgeLookup(query);
    return { results, source: 'claude-knowledge' };
  }
}

// Pure Claude knowledge lookup when Wowhead is unreachable or returns nothing useful
async function claudeKnowledgeLookup(query: string): Promise<WowheadResult[]> {
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are a Diablo 4 expert. Answer a database query using your knowledge of D4 items, aspects, and skills.
Return a JSON array: [{ "name": "...", "type": "item|aspect|skill|other", "description": "one sentence", "url": "" }]
Include all matching items/aspects. If the query is an aspect name, clarify whether it's a Legendary Aspect (Codex of Power) or a unique item affix.
OUTPUT: Valid JSON array only, no markdown.`,
    messages: [{
      role: 'user',
      content: `D4 database lookup: "${query}"`,
    }],
  });
  const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '[]';
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')) as WowheadResult[];
  } catch {
    return [];
  }
}
