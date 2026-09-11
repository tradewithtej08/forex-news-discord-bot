import { DateTime } from "luxon";
import crypto from "node:crypto";
import * as cheerio from "cheerio";

const IST = "Asia/Kolkata";
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FF_CALENDAR_URL = "https://www.forexfactory.com/calendar";

function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function normalizedTitle(s = "") {
  return clean(s).toLowerCase().replace(/\([^)]*\)/g, "").replace(/\b(prelim|final|revised|flash)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function eventKey(e) {
  const raw = `${e.currency}|${normalizedTitle(e.title)}|${e.timeIst.toFormat("yyyy-LL-dd HH:mm")}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20);
}
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

export async function fetchForexFactoryHighImpact() {
  const items = await fetchJson(FF_URL);
  return items.filter(x => String(x.impact).toLowerCase() === "high").map(x => ({
    title: clean(x.title),
    currency: clean(x.country || "ALL").toUpperCase(),
    timeIst: DateTime.fromISO(x.date, { setZone: true }).setZone(IST),
    forecast: clean(x.forecast),
    previous: clean(x.previous),
    actual: "",
    source: "Forex Factory",
    sourceDetails: { forexFactory: "High Impact" }
  })).filter(x => x.timeIst.isValid).map(x => ({ ...x, key: eventKey(x) })).sort((a, b) => a.timeIst.toMillis() - b.timeIst.toMillis());
}

export async function hydrateForexFactoryActuals(events, date = DateTime.now().setZone(IST)) {
  if (!events.length) return events;
  const ffDate = date.setZone(IST).toFormat("LLLdd.yyyy").toLowerCase();
  const url = `${FF_CALENDAR_URL}?range=${ffDate}-${ffDate}`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const actualMap = new Map();

  $(".calendar__row").each((_, row) => {
    const $row = $(row);
    if (!$row.attr("data-event-id")) return;
    const currency = clean($row.find(".calendar__currency").text()).toUpperCase();
    const title = clean($row.find(".calendar__event-title").text());
    const actual = clean($row.find(".calendar__actual").text());
    const forecast = clean($row.find(".calendar__forecast").text());
    const previous = clean($row.find(".calendar__previous").text());
    if (!currency || !title) return;
    actualMap.set(`${currency}|${normalizedTitle(title)}`, { actual, forecast, previous });
  });

  if (!actualMap.size) throw new Error("Forex Factory calendar page returned no parsable events");

  return events.map(event => {
    const live = actualMap.get(`${event.currency}|${normalizedTitle(event.title)}`);
    if (!live) return event;
    return {
      ...event,
      actual: live.actual || event.actual || "",
      forecast: live.forecast || event.forecast || "",
      previous: live.previous || event.previous || ""
    };
  });
}

export async function getTodayEvents() {
  const today = DateTime.now().setZone(IST).toISODate();
  try {
    const events = (await fetchForexFactoryHighImpact()).filter(e => e.timeIst.toISODate() === today);
    return { events, warnings: [] };
  } catch (error) { return { events: [], warnings: [`Forex Factory fetch failed: ${error?.message || error}`] }; }
}
export function formatTime(dt) { return dt.setZone(IST).toFormat("hh:mm a"); }
export function buildDailyEmbeds(events, date = DateTime.now().setZone(IST)) {
  const chunks = [];
  for (let i = 0; i < events.length; i += 8) chunks.push(events.slice(i, i + 8));
  if (!chunks.length) return [{ title: `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}`, description: "Aaj ke liye koi Forex Factory Red Folder / High Impact event nahi mila.", color: 0x2b2d31, footer: { text: "Source: Forex Factory • Timezone: IST" } }];
  return chunks.map((chunk, index) => ({
    title: index === 0 ? `📅 HIGH IMPACT NEWS — ${date.toFormat("dd LLL yyyy").toUpperCase()}` : "📅 HIGH IMPACT NEWS — CONTINUED",
    description: chunk.map(e => [`**${e.currency} — ${e.title}**`, `🕒 **${formatTime(e.timeIst)} IST**`, "🔴 FF Red Folder", e.forecast ? `Forecast: **${e.forecast}**${e.previous ? ` • Previous: **${e.previous}**` : ""}` : (e.previous ? `Previous: **${e.previous}**` : "")].filter(Boolean).join("\n")).join("\n\n"),
    color: 0xd32f2f,
    footer: { text: "15-minute reminder + result updates enabled • Source: Forex Factory • IST" }
  }));
}
export function buildReminderEmbed(event) {
  return {
    title: "🚨 NEWS IN 15 MINUTES",
    description: [`**${event.currency} — ${event.title}**`, `🕒 News Time: **${formatTime(event.timeIst)} IST**`, "🔴 Forex Factory: **Red Folder / High Impact**", "", "⚠️ High-impact news in 15 minutes. Manage trading risk accordingly."].join("\n"),
    color: 0xef4444,
    footer: { text: "Source: Forex Factory • Timezone: IST" }
  };
}
export function buildResultEmbed(event) {
  const lines = [
    `**${event.currency} — ${event.title}**`,
    `🕒 News Time: **${formatTime(event.timeIst)} IST**`,
    "",
    `📊 Actual: **${event.actual || "N/A"}**`,
    event.forecast ? `🎯 Forecast: **${event.forecast}**` : null,
    event.previous ? `📋 Previous: **${event.previous}**` : null
  ].filter(Boolean);
  return {
    title: "✅ NEWS RESULT RELEASED",
    description: lines.join("\n"),
    color: 0x22c55e,
    footer: { text: "Source: Forex Factory • Timezone: IST" }
  };
}
