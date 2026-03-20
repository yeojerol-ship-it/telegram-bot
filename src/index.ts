import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { supabase } from './supabase';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
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

async function fetchOgTitle(url: string): Promise<string | null> {
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const res = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    const html = await res.text();
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const name = ogTitle ?? pageTitle;
    return name?.trim() || null;
  } catch (e) {
    console.log('fetchOgTitle error:', e);
    return null;
  }
}

async function fetchTitle(url: string): Promise<string> {
  // Try jsonlink first — no API key needed
  const jsonlinkName = await fetchTitleViaJsonLink(url);
  if (jsonlinkName) return jsonlinkName;

  // Try Bing search as fallback
  const bingName = await fetchTitleViaBing(url);
  if (bingName) return bingName;

  // For Klook short URLs, resolve to get activity ID first
  let resolvedUrl = url;
  if (url.includes('klook')) {
    try {
      const res = await fetch(url.startsWith('http') ? url : 'https://' + url, {
        method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      resolvedUrl = res.url || url;
      console.log('klook resolved:', resolvedUrl);
    } catch {}
    const klookName = await fetchKlookTitle(resolvedUrl);
    if (klookName) return klookName;
  }

  // Try plain HTTP fetch for og:title
  const ogName = await fetchOgTitle(url);
  if (ogName) return ogName;

  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(fullUrl, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => document.title.length > 0, { timeout: 10000 });
    // Wait for page to render
    await new Promise(r => setTimeout(r, 3000));
    // Screenshot and send to Claude Vision to extract the name
    const screenshot = await page.screenshot({ encoding: 'base64' }) as string;
    const visionResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: 'What is the name of this activity/place shown on this page? Reply with only the name, nothing else.' },
        ],
      }],
    });
    const visionBlock = visionResponse.content[0];
    const name = visionBlock.type === 'text' ? visionBlock.text.trim() : '';
    console.log('claude vision name:', name);
    return name || 'Unnamed';
  } catch (e) {
    console.log('fetchTitle error:', e);
    return 'Unnamed';
  } finally {
    await browser.close();
  }
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
  flights: 'flight',
  activities: 'activity',
};

bot.command('remove', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const arg = parts[1]?.toLowerCase();
  const num = parseInt(parts[2]);

  const category = categoryMap[arg];
  if (!category || isNaN(num) || num < 1) {
    ctx.reply('Usage: /remove hotels 2 — removes item #2 from the list');
    return;
  }

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

  // Deduplicate to match what /list shows
  const seen = new Set<string>();
  const unique = data.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });

  const target = unique[num - 1];
  if (!target) {
    ctx.reply(`Hmm, there's no item #${num} in the ${arg} list. Try /list ${arg} to see what's there.`);
    return;
  }

  // Delete all rows with this URL in this chat
  const { error: deleteError } = await supabase
    .from('trip_links')
    .delete()
    .eq('chat_id', chatId)
    .eq('url', target.url);

  if (deleteError) {
    console.error('Delete error:', deleteError.message);
    ctx.reply('Failed to remove link');
  } else {
    ctx.reply(`Gone! Removed #${num} from ${CATEGORY_LABEL[category]} 🗑️`);
  }
});

bot.command('list', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const arg = parts[1]?.toLowerCase();

  const category = categoryMap[arg];
  if (!category) {
    ctx.reply('Try /list hotels, /list flights, or /list activities');
    return;
  }

  const chatId = ctx.chat.id.toString();
  const { data, error } = await supabase
    .from('trip_links')
    .select('url, user_name, label')
    .eq('chat_id', chatId)
    .eq('category', category)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Supabase fetch error:', error.message);
    ctx.reply('Failed to fetch links');
    return;
  }

  if (!data || data.length === 0) {
    ctx.reply(`No ${CATEGORY_LABEL[category]} saved yet — drop some links in the chat!`);
    return;
  }

  // Deduplicate by URL
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

  if (!URL_REGEX.test(text)) return;

  const url = text.match(URL_REGEX)![0];
  const userName = ctx.from?.username ?? ctx.from?.first_name ?? 'unknown';
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
