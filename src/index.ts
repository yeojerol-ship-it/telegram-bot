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

async function fetchTitleViaClaude(url: string, html?: string): Promise<string> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;

    if (!html) {
      try { html = await fetchPageHtml(url); } catch {}
    }

    // Prefer __NEXT_DATA__ (Next.js embeds full page props as JSON — much richer than og:title)
    let context = '';
    if (html) {
      const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      if (nextData) {
        context = nextData.slice(0, 5000);
      } else {
        context = html.slice(0, 4000);
      }
    }

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `Extract the specific product, hotel, or activity name from the data below. Return ONLY the name (max 60 chars) — no explanation, no quotes, no brand prefix like "KKday" or "Klook".

URL: ${fullUrl}
${context ? `Data:\n${context}` : ''}`,
      }],
    });

    const block = response.content[0];
    if (block.type !== 'text') return 'Unnamed';
    const title = block.text.trim();
    console.log('claude title:', title, 'for', url);
    return title || 'Unnamed';
  } catch (e) {
    console.log('fetchTitleViaClaude error:', e);
    return 'Unnamed';
  }
}

async function fetchTitle(url: string): Promise<string> {
  // 1. Try slug extraction from URL path (fast, no network)
  const slugName = extractNameFromUrl(url);
  if (slugName) return slugName;

  // 2. For JS-heavy sites (KKday, Klook): fetch HTML and send to Claude directly
  //    These sites use client-side rendering — og:title just returns the site name
  if (url.includes('kkday') || url.includes('klook')) {
    try {
      let targetUrl = url;
      // Resolve short/redirect URLs first
      try {
        const res = await fetch(url.startsWith('http') ? url : 'https://' + url, {
          method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        targetUrl = res.url || url;
      } catch {}
      const html = await fetchPageHtml(targetUrl);
      return await fetchTitleViaClaude(targetUrl, html);
    } catch (e) {
      console.log('kkday/klook claude fetch error:', e);
    }
  }

  // 3. For other sites: try og:title first (fast)
  const ogName = await fetchOgTitle(url);
  if (ogName) return ogName;

  // 4. Try jsonlink as a secondary option
  const jsonlinkName = await fetchTitleViaJsonLink(url);
  if (jsonlinkName) return jsonlinkName;

  // 5. Bing search fallback (if key set)
  const bingName = await fetchTitleViaBing(url);
  if (bingName) return bingName;

  // 6. Final fallback: Claude reads whatever HTML the page serves
  return await fetchTitleViaClaude(url);
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
      const { tagline, price } = await getSummary(name, category);
      const summaryText = tagline ? `\n<i>${tagline}</i>` : '';
      const priceText = price ? `\n💰 ${price}` : '';
      return `<b>${i + 1}. ${name}</b>${summaryText}${priceText}\n<a href="${row.url}">🔗 ${viewLabel[category]}</a>\nMentioned by ${row.user_name}`;
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

const URL_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/i;

const HOTEL_KEYWORDS = ['agoda', 'booking', 'airbnb', 'trip.com', 'hotels.com', 'expedia', 'hostelworld'];
const FLIGHT_KEYWORDS = ['skyscanner', 'airasia', 'thaivietjet', 'vietjetair', 'lionair', 'kayak', 'google.com/flights', 'flightguru'];

function categorize(url: string): string {
  const lower = url.toLowerCase();
  if (HOTEL_KEYWORDS.some((k) => lower.includes(k))) return 'hotel';
  if (FLIGHT_KEYWORDS.some((k) => lower.includes(k))) return 'flight';
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

  // ── URL save handler ───────────────────────────────────────────────────────
  if (!URL_REGEX.test(text)) return;

  const url = text.match(URL_REGEX)![0];
  const category = categorize(url);
  const label = await fetchTitle(url);

  const { error } = await supabase
    .from('trip_links')
    .insert({ chat_id: chatId, user_name: userName, message_text: text, url, category, label });

  if (error) {
    console.error('Supabase insert error:', error.message);
    ctx.reply('Failed to save link');
    return;
  }

  const categoryEmoji: Record<string, string> = { hotel: '⛺️', flight: '✈️', activity: '🔫' };
  ctx.reply(`${categoryEmoji[category]} Saved <b>${label}</b>`, { parse_mode: 'HTML' });
});

bot.launch();
console.log('Bot started successfully');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
