import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";
import fs from "node:fs/promises";
import path from "node:path";

const IST = "Asia/Kolkata";
const nowIst = DateTime.now().setZone(IST);
const dateIso = nowIst.toFormat("yyyy-LL-dd");
const url = `https://www.investing.com/economic-calendar/?dateFrom=${dateIso}&dateTo=${dateIso}`;

function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function parseTime(timeText) {
  const formats = ["HH:mm", "H:mm", "hh:mm a", "h:mm a"];
  for (const fmt of formats) {
    const t = DateTime.fromFormat(timeText, fmt, { zone: IST, locale: "en" });
    if (t.isValid) {
      return nowIst.startOf("day").set({ hour: t.hour, minute: t.minute });
    }
  }
  return null;
}

function parseRows(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, row) => {
    const tr = $(row);
    const cells = tr.find("td");
    if (cells.length < 4) return;

    const timeText = clean(tr.find(".time").first().text() || cells.eq(0).text());
    const currency = clean(tr.find(".flagCur").first().text() || cells.eq(1).text()).toUpperCase();
    const event = clean(tr.find(".event").first().text() || cells.eq(3).text());
    if (!timeText || !currency || !event) return;

    const impactCell = tr.find(".sentiment").first().length ? tr.find(".sentiment").first() : cells.eq(2);
    const impactHtml = impactCell.html() || "";
    const impactText = clean(impactCell.text()).toLowerCase();
    const titleText = clean(impactCell.attr("title") || "").toLowerCase();
    const iconCount = impactCell.find("i,span").filter((_, el) => {
      const cls = ($(el).attr("class") || "").toLowerCase();
      return cls.includes("bull") || cls.includes("importance") || cls.includes("sentiment");
    }).length;

    const isHigh =
      impactText.includes("high") ||
      titleText.includes("high") ||
      impactHtml.includes("bull3") ||
      impactHtml.includes("FullBullish") ||
      iconCount >= 3;

    if (!isHigh) return;

    let dt = null;
    const raw = tr.attr("data-event-datetime");
    if (raw) {
      dt = DateTime.fromFormat(raw, "yyyy/LL/dd HH:mm:ss", { zone: "America/New_York" });
      if (!dt.isValid) dt = DateTime.fromFormat(raw, "yyyy-LL-dd HH:mm:ss", { zone: "America/New_York" });
      if (!dt.isValid) dt = DateTime.fromISO(raw, { setZone: true });
      if (dt.isValid) dt = dt.setZone(IST);
    }
    if (!dt || !dt.isValid) dt = parseTime(timeText);
    if (!dt || !dt.isValid) return;

    const forecast = clean(tr.find(".fore").first().text() || (cells.length > 5 ? cells.eq(5).text() : ""));
    const previous = clean(tr.find(".prev").first().text() || (cells.length > 6 ? cells.eq(6).text() : ""));

    rows.push({
      currency,
      title: event,
      timeIst: dt.toISO(),
      forecast,
      previous,
      impact: 3,
      source: "Investing.com"
    });
  });

  const seen = new Set();
  return rows.filter(r => {
    const key = `${r.currency}|${r.title.toLowerCase()}|${r.timeIst}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const browser = await chromium.launch({ headless: true });
let events = [];
let diagnostics = {};

try {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: IST,
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  try {
    await page.locator("#onetrust-accept-btn-handler").click({ timeout: 5000 });
  } catch {}

  await page.waitForTimeout(8000);
  const html = await page.content();
  events = parseRows(html).filter(e => DateTime.fromISO(e.timeIst).setZone(IST).toISODate() === dateIso);

  diagnostics = {
    pageStatus: response?.status() ?? null,
    pageTitle: await page.title(),
    htmlLength: html.length,
    parsedEvents: events.length
  };
} finally {
  await browser.close();
}

const output = {
  date: dateIso,
  timezone: IST,
  generatedAt: DateTime.now().setZone(IST).toISO(),
  source: "Investing.com",
  impact: "3-star/high",
  events,
  diagnostics
};

await fs.mkdir(path.resolve("data"), { recursive: true });
await fs.writeFile(path.resolve("data/investing.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(`Saved ${events.length} Investing.com 3-star events for ${dateIso}`);
