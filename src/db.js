import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DB_PATH || "./data/bot.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sent_alerts (
  guild_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, event_key, alert_type)
);
`);

export function setGuildChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO guild_config (guild_id, channel_id, enabled)
    VALUES (?, ?, 1)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id=excluded.channel_id,
      enabled=1,
      updated_at=CURRENT_TIMESTAMP
  `).run(guildId, channelId);
}

export function getGuildConfig(guildId) {
  return db.prepare("SELECT * FROM guild_config WHERE guild_id = ?").get(guildId);
}

export function getEnabledGuilds() {
  return db.prepare("SELECT * FROM guild_config WHERE enabled = 1").all();
}

export function removeGuild(guildId) {
  db.prepare("DELETE FROM guild_config WHERE guild_id = ?").run(guildId);
  db.prepare("DELETE FROM sent_alerts WHERE guild_id = ?").run(guildId);
}

export function wasSent(guildId, eventKey, alertType) {
  return !!db.prepare(`
    SELECT 1 FROM sent_alerts
    WHERE guild_id = ? AND event_key = ? AND alert_type = ?
  `).get(guildId, eventKey, alertType);
}

export function markSent(guildId, eventKey, alertType) {
  db.prepare(`
    INSERT OR IGNORE INTO sent_alerts (guild_id, event_key, alert_type)
    VALUES (?, ?, ?)
  `).run(guildId, eventKey, alertType);
}

export function cleanupOldAlerts() {
  db.prepare(`
    DELETE FROM sent_alerts
    WHERE sent_at < datetime('now', '-14 days')
  `).run();
}
