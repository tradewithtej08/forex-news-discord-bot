import { DateTime } from "luxon";
import crypto from "node:crypto";

const IST = "Asia/Kolkata";
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const INVESTING_JSON_URL = "https://raw.githubusercontent.com/tradewithtej08/forex-news-discord-bot/main/data/investing.json";

function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function normalizedTitle(s = "") {
  return clean(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(prelim|final|revised|flash)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function eventKey(e) {
  const raw = `${e.currency}|${normalizedTitle(e.title)}|${e.timeIst.toFormat("yyyy-LL-dd HH:mm")}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FXTEJ-Forex-News-Bot/1.0", Accept: "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchForexFactoryHighImpact() {
  const items = await fetchJson(FF_URL);
  return items
    .filter(x => String(x.impact).toLowerCase() === "high")
    .map(x => ({
      title: clean(x.title),
      currency: clean(x.country || "ALL").toUpperCase(),
      timeIst: DateTime.fromISO(x.date, { setZone: true }).setZone(IST),
      forecast: clean(x.forecast),
      previous: clean(x.previous),
      sources: new Set(["Forex Factory"]),
      sourceDetails: { forexFactory: "High Impact", investing: null }
    }))
    .filter(x => x.timeIst.isValid);
}

export async function fetchInvestingHighImpact() {
  const data = await fetchJson(`${INVESTING_JSON_URL}?t=${Date.now()}`);
  const today = DateTime.now().setZone(IST).toISODate();

  if (data.date !== today) {
    throw new Error(`Investing JSON is stale: ${data.date || "no date"}, expected ${today}`);
  }

  return (data.events || []).map(x => ({
    title: clean(x.title),
    currency: clean(x.currency || "ALL").toUpperCase(),
    timeIst: DateTime.fromISO(x.timeIst, { setZone: true }).setZone(IST),
    forecast: clean(x.forecast),
    previous: clean(x.previous),
    sources: new Set(["Investing.com"]),
    sourceDetails: { forexFactory: null, investing: "⭐⭐⭐ High Impact" }
  })).filter(x => x.timeIst.isValid);
}

function closeEnough(a, b) {
  if (a.currency !== b.currency) return false;
  const minutes = Math.abs(a.timeIst.diff(b.timeIst, "minutes").minutes);
  if (minutes > 10) return false;
  const ta = normalizedTitle(a.title);
  const tb = normalizedTitle(b.title);
  return ta === tb || ta.includes(tb) || tb.includes(ta);
}

export function mergeEvents(ff, investing) {
  const merged = ff.map(x => ({ ...x, sources: new Set(x.sources) }));

  for (const item of investing) {
    const match = merged.find(x => closeEnough(x, item));
    if (match) {
      match.sources.add("Investing.com");
      match.sourceDetails.investing = "⭐⭐⭐ High Impact";
      if (!match.forecast) match.forecast = item.forecast;
      if (!match.previous) match.previous = item.previous;
    } else {
      merged.push({ ...item, sources: new Set(item.sources) });
    }
  }

  return merged
    .map(x => ({ ...x, key: eventKey(x), sources: [...x.sources] }))
    .sort((a, b) => a.timeIst.toMillis() - b.timeIst.toMillis());
}

export async function getTodayEvents() {
  const now = DateTime.now().setZone(IST);
  const today = now.toISODate();

  const settled = await Promise.allSettled([
    fetchForexFactoryHighImpact(),
    fetchInvestingHighImpact()
  ]);

  let ff = [];
  let investing = [];
  const warnings = [];

  if (settled[0].status === "fulfilled") {
    ff = settled[0].value.filter(e => e.timeIst.toISODate() === today);
  } else {
    warnings.push(`Forex Factory fetch failed: ${settled[0].reason?.message || settled[0].reason}`);
  }

  if (settled[1].status === "fulfilled") {
    investing = settled[1].value.filter(e => e.timeIst.toISODate() === today);
  } else {
    warnings.push(`Investing.com fetch failed: ${settled[1].reason?.message || settled[1].reason}`);
  }

  return { events: mergeEvents(ff, investing), warnings };
}

export function formatTime(dt) {
  return dt.setZone(IST).toFormat("hh:mm a");
}

export function buildDailyEmbeds(events, date = DateTime.now().setZone(IST)) {
  const chunks = [];
  for (let i = 0; i < events.length; i += 8) chunks.push(events.slice(i, i + 8));

  if (!chunks.length) {
    return [{
      title: `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}`,
      description: "Aaj ke liye koi Forex Factory Red Folder / Investing.com ⭐⭐⭐ event nahi mila.",
      color: 0x2b2d31,
      footer: { text: "Timezone: IST (Asia/Kolkata)" }
    }];
  }

  return chunks.map((chunk, index) => ({
    title: index === 0
      ? `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}`
      : "📅 HIGH IMPACT NEWS — CONTINUED",
    description: chunk.map(e => {
      const src = [
        e.sourceDetails.forexFactory ? "🔴 FF Red Folder" : null,
        e.sourceDetails.investing ? "⭐⭐⭐ Investing.com" : null
      ].filter(Boolean).join(" • ");

      return [
        `**${e.currency} — ${e.title}**`,
        `🕒 **${formatTime(e.timeIst)} IST**`,
        src,
        e.forecast
          ? `Forecast: **${e.forecast}**${e.previous ? ` • Previous: **${e.previous}**` : ""}`
          : (e.previous ? `Previous: **${e.previous}**` : "")
      ].filter(Boolean).join("\n");
    }).join("\n\n"),
    color: 0xd32f2f,
    footer: { text: "Automatic reminders: 1 hour & 15 minutes before news • IST" }
  }));
}

export function buildReminderEmbed(event, minutes) {
  const label = minutes === 60 ? "1 HOUR" : "15 MINUTES";
  return {
    title: `🚨 ${label} NEWS REMINDER`,
    description: [
      `**${event.currency} — ${event.title}**`,
      `🕒 News Time: **${formatTime(event.timeIst)} IST**`,
      event.sourceDetails.forexFactory ? "🔴 Forex Factory: **Red Folder / High Impact**" : null,
      event.sourceDetails.investing ? "⭐⭐⭐ Investing.com: **3-Star / High Impact**" : null,
      "",
      "⚠️ High-impact news ahead. Manage trading risk accordingly."
    ].filter(x => x !== null).join("\n"),
    color: minutes === 60 ? 0xf59e0b : 0xef4444,
    footer: { text: "Timezone: IST (Asia/Kolkata)" }
  };
}
