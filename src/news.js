import { DateTime } from "luxon";
import crypto from "node:crypto";

const IST = "Asia/Kolkata";
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

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
      headers: {
        "User-Agent": "FXTEJ-Forex-News-Bot/1.0",
        Accept: "application/json"
      }
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
      source: "Forex Factory",
      sourceDetails: { forexFactory: "High Impact" }
    }))
    .filter(x => x.timeIst.isValid)
    .map(x => ({ ...x, key: eventKey(x) }))
    .sort((a, b) => a.timeIst.toMillis() - b.timeIst.toMillis());
}

export async function getTodayEvents() {
  const today = DateTime.now().setZone(IST).toISODate();

  try {
    const events = (await fetchForexFactoryHighImpact())
      .filter(e => e.timeIst.toISODate() === today);

    return { events, warnings: [] };
  } catch (error) {
    return {
      events: [],
      warnings: [`Forex Factory fetch failed: ${error?.message || error}`]
    };
  }
}

export function formatTime(dt) {
  return dt.setZone(IST).toFormat("hh:mm a");
}

export function buildDailyEmbeds(events, date = DateTime.now().setZone(IST)) {
  const chunks = [];
  for (let i = 0; i < events.length; i += 8) {
    chunks.push(events.slice(i, i + 8));
  }

  if (!chunks.length) {
    return [{
      title: `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}`,
      description: "Aaj ke liye koi Forex Factory Red Folder / High Impact event nahi mila.",
      color: 0x2b2d31,
      footer: { text: "Source: Forex Factory • Timezone: IST" }
    }];
  }

  return chunks.map((chunk, index) => ({
    title: index === 0
      ? `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}`
      : "📅 HIGH IMPACT NEWS — CONTINUED",

    description: chunk.map(e => [
      `**${e.currency} — ${e.title}**`,
      `🕒 **${formatTime(e.timeIst)} IST**`,
      "🔴 FF Red Folder",
      e.forecast
        ? `Forecast: **${e.forecast}**${e.previous ? ` • Previous: **${e.previous}**` : ""}`
        : (e.previous ? `Previous: **${e.previous}**` : "")
    ].filter(Boolean).join("\n")).join("\n\n"),

    color: 0xd32f2f,
    footer: {
      text: "Automatic reminder: 15 minutes before news • IST"
    }
  }));
}

export function buildReminderEmbed(event) {
  return {
    title: "🚨 15 MINUTES NEWS REMINDER",
    description: [
      `**${event.currency} — ${event.title}**`,
      `🕒 News Time: **${formatTime(event.timeIst)} IST**`,
      "🔴 Forex Factory: **Red Folder / High Impact**",
      "",
      "⚠️ High-impact news ahead. Manage trading risk accordingly."
    ].join("\n"),
    color: 0xef4444,
    footer: { text: "Source: Forex Factory • Timezone: IST" }
  };
}
