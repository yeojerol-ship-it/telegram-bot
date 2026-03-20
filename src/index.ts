import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { supabase } from './supabase';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
}

const bot = new Telegraf(token);

bot.command('start', (ctx) => {
  ctx.reply("✈️ Trip planner bot is live! Drop links in the chat and I'll save them for the crew.");
});

bot.command('help', (ctx) => {
  ctx.reply(
    "Here's what I can do:\n\n" +
    "📎 Drop any hotel, flight, or activity link — I'll save it automatically\n\n" +
    "/list hotels — see all saved hotels\n" +
    "/list flights — see all saved flights\n" +
    "/list activities — see all saved activities\n" +
    "/remove hotels 2 — remove item #2 from the hotels list"
  );
});

async function fetchTitleViaJsonLink(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://jsonlink.io/api/extract?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json() as any;
    console.log('jsonlink title:', json?.title);
    return json?.title?.trim() || null;
  } catch (e) {
    console.log('jsonlink error:', e);
    return null;
  }
}

async function fetchTitleViaBing(url: string): Promise<string | null> {
  const key = process.env.BING_API_KEY;
  if (!key || key === 'your_bing_api_key_here') return null;
  try {
    const query = encodeURIComponent(url);
    const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${query}&count=1`, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json() as any;
    const name = json?.webPages?.value?.[0]?.name;
    console.log('bing title:', name);
    return name?.trim() || null;
  } catch (e) {
    console.log('bing error:', e);
    return null;
  }
}

async function fetchKlookTitle(url: string): Promise<string | null> {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    const json = await res.json() as { contents?: string };
    const html = json.contents ?? '';
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const name = ogTitle ?? pageTitle;
    console.log('allorigins og:title:', ogTitle, '| title:', pageTitle);
    return name?.trim() || null;
  } catch (e) {
    console.log('fetchKlookTitle error:', e);
    return null;
  }
}

function extractNameFromUrl(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url.startsWith('http') ? url : 'https://' + url);
    if (hostname.includes('kkday')) {
      // /product/2287-activity-name
      const productMatch = pathname.match(/\/product\/\d+-([^/?]+)/i);
      if (productMatch) return productMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // /product/productlist/disney%20cruise
      const listMatch = pathname.match(/\/productlist\/([^/?]+)/i);
      if (listMatch) return decodeURIComponent(listMatch[1]).replace(/[+-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // /cruises/528868 or /en-sg/product/528868 — use last path segment as fallback label
      const segments = pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && !/^\d+$/.test(last)) return decodeURIComponent(last).replace(/[+-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    // Klook: klook.com/activity/12345-activity-name-here
    if (hostname.includes('klook')) {
      const match = pathname.match(/\/activity\/\d+-([^/?]+)/i);
      if (match) return match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  } catch {}
  return null;
}

async function fetchOgTitle(url: string): Promise<string | null> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const res = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    const html = await res.text();
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const name = ogTitle ?? pageTitle;
    console.log('fetchOgTitle result:', name, 'for', url);
    return (name && name !== 'kkday.com' && name !== 'klook.com') ? name.trim() : null;
  } catch (e) {
    console.log('fetchOgTitle error:', e);
    return null;
  }
}

// Search DuckDuckGo for the URL — it returns the indexed page title from its crawl cache
async function fetchTitleViaDDG(url: string): Promise<string | null> {
  try {
    const { hostname, pathname } = new URL(url.startsWith('http') ? url : 'https://' + url);
    const query = encodeURIComponent(`${hostname}${pathname}`);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/class="result__a"[^>]*>([^<]+)<\/a>/);
    const title = titleMatch?.[1]?.trim();
    console.log('ddg title:', title);
    if (title && !isGenericTitle(title)) return title;
    return null;
  } catch (e) {
    console.log('ddg error:', e);
    return null;
  }
}

// Check Wayback Machine for a cached snapshot of the page
async function fetchTitleViaWayback(url: string): Promise<string | null> {
  try {
    const check = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000),
    });
    const json = await check.json() as any;
    const snapshotUrl = json?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) return null;

    const res = await fetch(snapshotUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const name = ogTitle ?? pageTitle;
    console.log('wayback title:', name);
    if (name && !isGenericTitle(name)) return name.trim();
    return null;
  } catch (e) {
    console.log('wayback error:', e);
    return null;
  }
}

async function fetchTitleViaClaudeSearch(url: string): Promise<string | null> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const messages: any[] = [{
      role: 'user',
      content: `Search the web for this exact URL and find the product or activity name from the search results. Reply with ONLY the name in 3-5 words — no brand prefix, no explanation.\n\nURL: ${fullUrl}`,
    }];

    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 60,
        tools: [{ type: 'web_search_20260209', name: 'web_search' } as any],
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b: any) => b.type === 'text');
        if (textBlock && 'text' in textBlock) {
          const title = (textBlock as any).text.trim();
          console.log('claude search title:', title);
          if (title && title.length > 2 && title.length < 80 && !isGenericTitle(title)) return title;
        }
        return null;
      }
      // pause_turn: continue loop
    }
    return null;
  } catch (e) {
    console.log('claude search error:', e);
    return null;
  }
}

async function fetchPageHtml(url: string): Promise<string> {
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  const res = await fetch(fullUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  return res.text();
}

async function fetchTitleViaClaude(url: string, html?: string): Promise<string | null> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;

    if (!html) {
      try { html = await fetchPageHtml(url); } catch {}
    }

    let context = '';
    if (html) {
      const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      context = nextData ? nextData.slice(0, 5000) : html.slice(0, 4000);
    }

    // If page is CAPTCHA or empty, skip Claude — it'll just explain why it can't help
    if (!context || /captcha|blocked|security check|verify you are/i.test(context)) return null;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `From the data below, return ONLY the product/hotel/activity name in 1-6 words. No explanation. If you cannot find a name, reply with exactly: unknown

URL: ${fullUrl}
Data: ${context}`,
      }],
    });

    const block = response.content[0];
    if (block.type !== 'text') return null;
    const title = block.text.trim();
    console.log('claude title:', title, 'for', url);
    if (!title || title.toLowerCase() === 'unknown' || title.length > 80) return null;
    return title;
  } catch (e) {
    console.log('fetchTitleViaClaude error:', e);
    return null;
  }
}

function urlFallbackTitle(url: string): string {
  try {
    const { hostname, pathname, searchParams } = new URL(url.startsWith('http') ? url : 'https://' + url);
    const domain = hostname.replace('www.', '').split('.')[0];
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    // KKday: extract product ID
    const kkdayId = pathname.match(/\/product\/(\d+)/)?.[1];
    if (kkdayId) return `KKday Product #${kkdayId}`;

    // Klook: extract activity ID
    const klookId = pathname.match(/\/activity\/(\d+)/)?.[1];
    if (klookId) return `Klook Activity #${klookId}`;

    // Agoda: extract activityId param
    const agodaActivityId = searchParams.get('activityId');
    if (agodaActivityId) return `Agoda Activity #${agodaActivityId}`;

    // Generic: use last meaningful path segment
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length > 3 && !/^\d+$/.test(last)) {
      return `${decodeURIComponent(last).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} (${cap(domain)})`;
    }

    return `${cap(domain)} Link`;
  } catch {
    return 'Saved Link';
  }
}

const GENERIC_BRANDS = ['kkday', 'klook', 'agoda', 'booking', 'expedia', 'airbnb', 'tripadvisor'];
const GENERIC_PHRASES = ['book tours', 'book online', 'book activities', 'home page', 'explore. dream', 'things to do', 'best price'];

function isGenericTitle(title: string): boolean {
  const lower = title.toLowerCase().trim();
  // Brand name alone or with short suffix
  if (GENERIC_BRANDS.some(b => lower === b || lower === b + '.com')) return true;
  // Title starts with brand: "KKday - ..." or "Klook | ..."
  if (GENERIC_BRANDS.some(b => lower.startsWith(b + ' ') || lower.startsWith(b + '-') || lower.startsWith(b + '|'))) return true;
  // Title ends with brand: "Some tagline - KKday" or "Some tagline | Klook"
  if (GENERIC_BRANDS.some(b => lower.endsWith('- ' + b) || lower.endsWith('| ' + b) || lower.endsWith(' ' + b))) return true;
  // Generic marketing phrases
  if (GENERIC_PHRASES.some(p => lower.includes(p))) return true;
  return false;
}

async function fetchTitleViaSocialCrawler(url: string): Promise<string | null> {
  const userAgents = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'TelegramBot (like TwitterBot)',
  ];
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  for (const ua of userAgents) {
    try {
      const res = await fetch(fullUrl, {
        headers: { 'User-Agent': ua, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      const html = await res.text();
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
      console.log(`social crawler (${ua.split('/')[0]}):`, ogTitle);
      if (ogTitle && !isGenericTitle(ogTitle)) return ogTitle.trim();
    } catch (e) {
      console.log('social crawler error:', e);
    }
  }
  return null;
}

async function fetchTitleViaJina(url: string): Promise<string | null> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const res = await fetch(`https://r.jina.ai/${fullUrl}`, {
      headers: {
        'Accept': 'text/markdown, text/plain',
        'X-Return-Format': 'markdown',
        'X-Timeout': '10',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Jina returns "Title: <title>" near the top
    const titleMatch = text.match(/^Title:\s*(.+)$/m) ?? text.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim();
    console.log('jina title:', title);
    if (!title || title.length < 3) return null;
    return title;
  } catch (e) {
    console.log('jina error:', e);
    return null;
  }
}

async function fetchTitle(url: string): Promise<string | null> {
  // 1. Slug from URL path — instant, no network
  const slugName = extractNameFromUrl(url);
  if (slugName) return slugName;

  // 2. Claude web_search — searches the web index where KKday/Klook are already indexed correctly
  const claudeWebName = await fetchTitleViaClaudeSearch(url);
  if (claudeWebName) return claudeWebName;

  // 3. DuckDuckGo search — uses DDG's crawl index which has the real page title
  const ddgName = await fetchTitleViaDDG(url);
  if (ddgName) return ddgName;

  // 3. Wayback Machine — fetches a cached snapshot with full HTML
  const waybackName = await fetchTitleViaWayback(url);
  if (waybackName) return waybackName;

  // 4. Social media crawler UAs — sites serve og:title to Facebook/Twitter/Telegram bots
  const socialName = await fetchTitleViaSocialCrawler(url);
  if (socialName) return socialName;

  // 5. Jina AI Reader — renders JS pages, returns clean markdown with real title
  const jinaName = await fetchTitleViaJina(url);
  if (jinaName && !isGenericTitle(jinaName)) return jinaName;

  // 6. og:title via plain fetch (SSR sites like Booking/Agoda)
  const ogName = await fetchOgTitle(url);
  if (ogName && !isGenericTitle(ogName)) return ogName;

  // 7. jsonlink
  const jsonlinkName = await fetchTitleViaJsonLink(url);
  if (jsonlinkName) return jsonlinkName;

  // 8. Bing API (if key set)
  const bingName = await fetchTitleViaBing(url);
  if (bingName) return bingName;

  // 9. Claude reads __NEXT_DATA__ / raw HTML
  const claudeName = await fetchTitleViaClaude(url);
  if (claudeName) return claudeName;

  // 10. Give up — caller will ask the user
  return null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRICE_LABEL: Record<string, string> = {
  hotel: 'per night',
  flight: 'per person',
  activity: 'per person',
};

const PRICE_PROMPT: Record<string, string> = {
  hotel: 'Estimated avg price per night in May 2026 in SGD (e.g. "~SGD 180/night").',
  flight: 'Estimated avg flight price per person in May 2026 in SGD (e.g. "~SGD 320/person").',
  activity: 'Estimated price per person in SGD (e.g. "~SGD 45/person").',
};

const TAGLINE_PROMPT: Record<string, string> = {
  hotel: 'A tagline under 100 characters describing the hotel.',
  flight: 'A tagline under 100 characters describing what this airline/route is known for.',
  activity: 'A tagline under 100 characters describing this activity.',
};

async function getSummary(name: string, category: string): Promise<{ tagline: string; price: string }> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `For "${name}", reply with exactly 2 lines:
Line 1: ${TAGLINE_PROMPT[category]}
Line 2: ${PRICE_PROMPT[category]} If unknown, give a best estimate based on the tier/type.
Reply with only these 2 lines, no labels.`,
      }],
    });
    const block = response.content[0];
    if (block.type !== 'text') return { tagline: '', price: '' };
    const lines = block.text.trim().split('\n').map(l => l.trim());
    return { tagline: lines[0] || '', price: lines[1] || '' };
  } catch (e) {
    console.log('getSummary error:', e);
    return { tagline: '', price: '' };
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  hotel: '⛺️ Hotels',
  flight: '✈️ Flights',
  activity: '🔫 Activities',
};

const categoryMap: Record<string, string> = {
  hotels: 'hotel',
  hotel: 'hotel',
  flights: 'flight',
  flight: 'flight',
  activities: 'activity',
  activity: 'activity',
  attraction: 'activity',
  attractions: 'activity',
};

// ── Shared list logic ────────────────────────────────────────────────────────

async function listCategory(ctx: any, category: string) {
  const chatId = ctx.chat.id.toString();
  const { data, error } = await supabase
    .from('trip_links')
    .select('url, user_name, label')
    .eq('chat_id', chatId)
    .eq('category', category)
    .order('created_at', { ascending: true });

  if (error) {
    ctx.reply('Failed to fetch links');
    return;
  }

  if (!data || data.length === 0) {
    ctx.reply(`No ${CATEGORY_LABEL[category]} saved yet — drop some links in the chat!`);
    return;
  }

  const seen = new Set<string>();
  const unique = data.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });

  const viewLabel: Record<string, string> = {
    hotel: 'View hotel',
    flight: 'View flight',
    activity: 'View activity',
  };

  const lines = await Promise.all(
    unique.map(async (row, i) => {
      const name = row.label || 'Unnamed';
      const safeName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const { tagline, price } = await getSummary(name, category);
      const safeTagline = tagline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const summaryText = safeTagline ? `\n<i>${safeTagline}</i>` : '';
      const priceText = price ? `\n💰 ${price}` : '';
      return `<b>${i + 1}. ${safeName}</b>${summaryText}${priceText}\n<a href="${row.url}">🔗 ${viewLabel[category]}</a>\nMentioned by ${row.user_name}`;
    })
  );

  const summary = `${unique.length} option${unique.length === 1 ? '' : 's'} on the list so far`;
  ctx.reply(`<b>${CATEGORY_LABEL[category]}</b>\n${summary}\n\n${lines.join('\n\n')}`, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// ── Shared remove logic ──────────────────────────────────────────────────────

async function removeFromCategory(ctx: any, category: string, num: number) {
  const chatId = ctx.chat.id.toString();
  const { data, error } = await supabase
    .from('trip_links')
    .select('id, url')
    .eq('chat_id', chatId)
    .eq('category', category)
    .order('created_at', { ascending: true });

  if (error || !data) {
    ctx.reply('Failed to fetch links');
    return;
  }

  const seen = new Set<string>();
  const unique = data.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });

  const target = unique[num - 1];
  if (!target) {
    ctx.reply(`Hmm, there's no item #${num} in that list.`);
    return;
  }

  const { error: deleteError } = await supabase
    .from('trip_links')
    .delete()
    .eq('chat_id', chatId)
    .eq('url', target.url);

  if (deleteError) {
    ctx.reply('Failed to remove link');
  } else {
    ctx.reply(`Gone! Removed #${num} from ${CATEGORY_LABEL[category]} 🗑️`);
  }
}

// ── Claude intent parsing ────────────────────────────────────────────────────

type Intent =
  | { action: 'list'; category: string }
  | { action: 'remove'; category: string; number: number }
  | { action: 'help' }
  | { action: 'unknown' };

async function parseIntent(text: string): Promise<Intent> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `You are a trip planning bot assistant. Classify this message intent and reply with JSON only — no explanation.

Message: "${text}"

Possible intents:
- List saved links: {"action":"list","category":"hotel"|"flight"|"activity"}
- Remove an item: {"action":"remove","category":"hotel"|"flight"|"activity","number":<integer>}
- Help request: {"action":"help"}
- Anything else: {"action":"unknown"}

Reply with only the JSON object.`,
      }],
    });
    const block = response.content[0];
    if (block.type !== 'text') return { action: 'unknown' };
    const json = JSON.parse(block.text.trim().replace(/^```json|```$/g, '').trim());
    return json as Intent;
  } catch {
    return { action: 'unknown' };
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command('remove', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const arg = parts[1]?.toLowerCase();
  const num = parseInt(parts[2]);
  const category = categoryMap[arg];
  if (!category || isNaN(num) || num < 1) {
    ctx.reply('Usage: /remove hotels 2 — removes item #2 from the list');
    return;
  }
  await removeFromCategory(ctx, category, num);
});

bot.command('list', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const arg = parts[1]?.toLowerCase();
  const category = categoryMap[arg];
  if (!category) {
    ctx.reply('Try /list hotels, /list flights, or /list activities');
    return;
  }
  await listCategory(ctx, category);
});

// Track bot messages waiting for a user-provided name
// key: `${chatId}:${botMessageId}`, value: url awaiting a label
const pendingRenames = new Map<string, string>();

const URL_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/i;

async function categorize(url: string): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Classify this URL as exactly one of: hotel, flight, activity\nBase your answer on the domain name, URL path, and query parameters.\nReply with one word only.\n\nURL: ${url}`,
      }],
    });
    const block = response.content[0];
    if (block.type === 'text') {
      const cat = block.text.trim().toLowerCase();
      if (['hotel', 'flight', 'activity'].includes(cat)) {
        console.log('claude category:', cat, 'for', url);
        return cat;
      }
    }
  } catch (e) {
    console.log('categorize error:', e);
  }

  // Fallback: keyword matching
  const lower = url.toLowerCase();
  if (/\/(activities|attractions|things-to-do|experiences|tours?)\//.test(lower)) return 'activity';
  if (/[?&](activityId|attractionId|tourId)=/.test(lower)) return 'activity';
  const HOTEL_KEYWORDS = ['agoda', 'booking', 'airbnb', 'trip.com', 'hotels.com', 'expedia', 'hostelworld'];
  const FLIGHT_KEYWORDS = ['skyscanner', 'airasia', 'thaivietjet', 'vietjetair', 'lionair', 'kayak', 'google.com/flights'];
  if (HOTEL_KEYWORDS.some(k => lower.includes(k))) return 'hotel';
  if (FLIGHT_KEYWORDS.some(k => lower.includes(k))) return 'flight';
  return 'activity';
}

bot.on('message', async (ctx) => {
  const text = 'text' in ctx.message ? ctx.message.text : null;
  if (!text) return;

  const chatId = ctx.chat.id.toString();
  const userName = ctx.from?.username ?? ctx.from?.first_name ?? 'unknown';

  // ── @ mention handler ──────────────────────────────────────────────────────
  const botUsername = ctx.botInfo?.username;
  const mentionPattern = botUsername ? new RegExp(`@${botUsername}`, 'i') : null;

  if (mentionPattern && mentionPattern.test(text)) {
    const query = text.replace(mentionPattern, '').trim();
    if (!query) {
      ctx.reply("Hey! 👋 Try asking me things like:\n• \"@bot show me the hotels\"\n• \"@bot what activities do we have?\"\n• \"@bot remove hotel 2\"");
      return;
    }

    const intent = await parseIntent(query);

    if (intent.action === 'list') {
      await listCategory(ctx, intent.category);
    } else if (intent.action === 'remove') {
      await removeFromCategory(ctx, intent.category, intent.number);
    } else if (intent.action === 'help') {
      ctx.reply(
        "Here's what I can do:\n\n" +
        "📎 Drop any hotel, flight, or activity link — I'll save it automatically\n\n" +
        "/list hotels — see all saved hotels\n" +
        "/list flights — see all saved flights\n" +
        "/list activities — see all saved activities\n" +
        "/remove hotels 2 — remove item #2 from the hotels list\n\n" +
        "Or just @ me in plain English!"
      );
    } else {
      ctx.reply("Not sure what you mean 🤔 Try something like \"show me the hotels\" or \"remove activity 3\"");
    }
    return;
  }

  // ── Pending rename reply handler ───────────────────────────────────────────
  const replyToId = 'reply_to_message' in ctx.message ? ctx.message.reply_to_message?.message_id : undefined;
  if (replyToId) {
    const pendingKey = `${chatId}:${replyToId}`;
    const pendingUrl = pendingRenames.get(pendingKey);
    if (pendingUrl) {
      const name = text.trim();
      await supabase
        .from('trip_links')
        .update({ label: name })
        .eq('chat_id', chatId)
        .eq('url', pendingUrl);
      pendingRenames.delete(pendingKey);
      ctx.reply(`✅ Got it! Saved as "<b>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>" 🎉`, { parse_mode: 'HTML' });
      return;
    }
  }

  // ── URL save handler ───────────────────────────────────────────────────────
  if (!URL_REGEX.test(text)) return;

  const url = text.match(URL_REGEX)![0];
  const [category, label] = await Promise.all([categorize(url), fetchTitle(url)]);

  const { error } = await supabase
    .from('trip_links')
    .insert({ chat_id: chatId, user_name: userName, message_text: text, url, category, label: label ?? null });

  if (error) {
    console.error('Supabase insert error:', error.message);
    ctx.reply('Failed to save link');
    return;
  }

  const categoryEmoji: Record<string, string> = { hotel: '⛺️', flight: '✈️', activity: '🔫' };

  if (!label) {
    const categoryWord: Record<string, string> = { hotel: 'hotel', flight: 'flight', activity: 'activity' };
    const sent = await ctx.reply(
      `${categoryEmoji[category]} Link saved! Give this ${categoryWord[category]} a name to remember it by 📝\n<i>(just reply to this message)</i>`,
      { parse_mode: 'HTML' }
    );
    pendingRenames.set(`${chatId}:${sent.message_id}`, url);
  } else {
    const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    ctx.reply(`${categoryEmoji[category]} Saved <b>${safeLabel}</b>`, { parse_mode: 'HTML' });
  }
});

bot.launch();
console.log('Bot started successfully');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
