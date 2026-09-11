import "dotenv/config";
import { Client, GatewayIntentBits, Events, EmbedBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { DateTime } from "luxon";
import { setGuildChannel, getGuildConfig, getEnabledGuilds, removeGuild, wasSent, markSent, cleanupOldAlerts, saveNewsCache, loadNewsCache } from "./db.js";
import { getTodayEvents, buildDailyEmbeds, buildReminderEmbed, buildResultEmbed, hydrateForexFactoryActuals } from "./news.js";

const IST = "Asia/Kolkata";
const NEWS_CACHE_MS = 30 * 60 * 1000;
const RESULT_POLL_MS = 60 * 1000;
const RESULT_WINDOW_MINUTES = 120;
if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in environment variables");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let cache = { date: null, events: [], warnings: [], fetchedAt: null, fromFallback: false };
let tickRunning = false;
let lastResultPollAt = 0;
let lastDailyRunDate = null;

function asEmbed(data) { return new EmbedBuilder(data); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isSupportedTextChannel(channel) { return channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type); }
function normalizeChannelName(name = "") { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function findNewsChannel(guild) {
  const preferred = ["red-folder-news", "redfoldernews", "forex-news", "news"];
  return [...guild.channels.cache.values()].filter(isSupportedTextChannel).find(ch => preferred.includes(normalizeChannelName(ch.name))) || null;
}

async function alreadyPostedInDiscord(channel, embedData) {
  try {
    await sleep(300 + Math.floor(Math.random() * 1200));
    const messages = await channel.messages.fetch({ limit: 30 });
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    return messages.some(message => {
      if (message.author?.id !== client.user?.id || message.createdTimestamp < cutoff) return false;
      return message.embeds.some(embed => embed.title === embedData.title && embed.description === embedData.description);
    });
  } catch (err) {
    console.warn(`[channel ${channel.id}] Duplicate check unavailable: ${err?.message || err}`);
    return false;
  }
}
async function sendUniqueEmbed(channel, embedData, pingEveryone = true) {
  if (await alreadyPostedInDiscord(channel, embedData)) {
    console.log(`[channel ${channel.id}] Duplicate post blocked: ${embedData.title}`);
    return false;
  }
  const payload = { embeds: [asEmbed(embedData)] };
  if (pingEveryone) { payload.content = "@everyone"; payload.allowedMentions = { parse: ["everyone"] }; }
  await channel.send(payload);
  return true;
}
async function recoverMissingGuildConfigs() {
  let recovered = 0;
  for (const guild of client.guilds.cache.values()) {
    if (getGuildConfig(guild.id)) continue;
    const channel = findNewsChannel(guild);
    if (!channel) { console.warn(`[guild ${guild.id}] No saved config and no #red-folder-news style channel found.`); continue; }
    setGuildChannel(guild.id, channel.id); recovered += 1;
    console.log(`[guild ${guild.id}] Recovered news config -> #${channel.name}`);
  }
  return recovered;
}
async function refreshNews(force = false) {
  const now = DateTime.now().setZone(IST); const today = now.toISODate();
  const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt) > NEWS_CACHE_MS || cache.date !== today;
  if (!force && !stale) return cache;
  const previous = cache; const result = await getTodayEvents();
  if (result.warnings.length) {
    console.warn("[news warnings]", result.warnings);
    if (previous.date === today && previous.events.length) { cache = { ...previous, warnings: result.warnings, fetchedAt: Date.now(), fromFallback: true }; return cache; }
    const stored = loadNewsCache(today);
    if (stored?.events?.length) { cache = { date: today, events: stored.events, warnings: result.warnings, fetchedAt: Date.now(), fromFallback: true }; return cache; }
    cache = { date: today, events: [], warnings: result.warnings, fetchedAt: Date.now(), fromFallback: false }; return cache;
  }
  cache = { date: today, events: result.events, warnings: [], fetchedAt: Date.now(), fromFallback: false };
  saveNewsCache(today, result.events); return cache;
}
async function resolveConfiguredChannel(config) {
  try {
    const guild = client.guilds.cache.get(config.guild_id);
    if (!guild) { console.warn(`[guild ${config.guild_id}] Bot is not connected; skipping.`); return null; }
    let channel = guild.channels.cache.get(config.channel_id) || await guild.channels.fetch(config.channel_id).catch(() => null);
    if (!isSupportedTextChannel(channel)) {
      const fallback = findNewsChannel(guild);
      if (fallback) { setGuildChannel(guild.id, fallback.id); console.log(`[guild ${guild.id}] Recovered missing channel -> #${fallback.name}`); return fallback; }
      return null;
    }
    return channel;
  } catch (err) { console.error(`[guild ${config.guild_id}] Channel resolve failed:`, err); return null; }
}
async function postDailyToGuild(config, forcePost = false) {
  const now = DateTime.now().setZone(IST); const alertType = `daily-${now.toISODate()}`;
  if (!forcePost && wasSent(config.guild_id, now.toISODate(), alertType)) return;
  const channel = await resolveConfiguredChannel(config); if (!channel) return;
  const { events, warnings, fromFallback } = await refreshNews(false); const embeds = buildDailyEmbeds(events, now);
  for (let i = 0; i < embeds.length; i++) await sendUniqueEmbed(channel, embeds[i], i === 0);
  if (!forcePost) markSent(config.guild_id, now.toISODate(), alertType);
  console.log(`[guild ${config.guild_id}] Daily news handled for #${channel.name}`);
  if (warnings.length) console.warn(`[${config.guild_id}] source warnings:`, warnings);
  if (fromFallback) console.warn(`[${config.guild_id}] Used cached Forex Factory schedule data.`);
}
async function process15MinuteReminders(config, events, now) {
  const channel = await resolveConfiguredChannel(config); if (!channel) return;
  for (const event of events) {
    const mins = event.timeIst.diff(now, "minutes").minutes;
    if (!(mins <= 15 && mins > 13.8) || wasSent(config.guild_id, event.key, "reminder-15")) continue;
    await sendUniqueEmbed(channel, buildReminderEmbed(event), true);
    markSent(config.guild_id, event.key, "reminder-15");
    console.log(`[guild ${config.guild_id}] 15m reminder handled for ${event.currency} ${event.title}`);
  }
}
async function processNewsResults(config, events, now) {
  const channel = await resolveConfiguredChannel(config); if (!channel) return;
  for (const event of events) {
    const minsSince = now.diff(event.timeIst, "minutes").minutes;
    if (minsSince < 0 || minsSince > RESULT_WINDOW_MINUTES || !event.actual || wasSent(config.guild_id, event.key, "news-result")) continue;
    await sendUniqueEmbed(channel, buildResultEmbed(event), true);
    markSent(config.guild_id, event.key, "news-result");
    console.log(`[guild ${config.guild_id}] Result handled for ${event.currency} ${event.title} -> ${event.actual}`);
  }
}
async function schedulerTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = DateTime.now().setZone(IST);
    const today = now.toISODate();
    if (now.hour === 23 && now.minute === 55) await recoverMissingGuildConfigs();
    if (now.hour === 23 && now.minute >= 50) await refreshNews(false);
    if (now.hour === 0 && now.minute === 0 && lastDailyRunDate !== today) {
      lastDailyRunDate = today;
      await recoverMissingGuildConfigs();
      await refreshNews(true);
      const currentConfigs = getEnabledGuilds();
      console.log(`[daily] ${currentConfigs.length} configured server(s), ${client.guilds.cache.size} connected server(s).`);
      for (const config of currentConfigs) {
        try { await postDailyToGuild(config); } catch (err) { console.error("Daily post failed:", config.guild_id, err); }
      }
    }
    let { events } = await refreshNews(false);
    const resultWindowOpen = events.some(event => {
      const minsSince = now.diff(event.timeIst, "minutes").minutes;
      return minsSince >= 0 && minsSince <= RESULT_WINDOW_MINUTES;
    });
    if (resultWindowOpen && Date.now() - lastResultPollAt >= RESULT_POLL_MS) {
      lastResultPollAt = Date.now();
      try {
        ({ events } = await refreshNews(true));
        events = await hydrateForexFactoryActuals(events, now);
        console.log(`[results] Forex Factory live page checked; ${events.filter(e => e.actual).length} event(s) currently have actual values.`);
      } catch (err) { console.error(`[results] Live Forex Factory result fetch failed: ${err?.message || err}`); }
    }
    const configs = getEnabledGuilds();
    for (const config of configs) {
      try { await process15MinuteReminders(config, events, now); } catch (err) { console.error("15m reminder failed:", config.guild_id, err); }
      try { await processNewsResults(config, events, now); } catch (err) { console.error("News result failed:", config.guild_id, err); }
    }
    if (now.hour === 3 && now.minute === 0) cleanupOldAlerts();
  } catch (err) { console.error("Scheduler tick failed:", err); }
  finally { tickRunning = false; }
}
client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Connected to ${readyClient.guilds.cache.size} Discord server(s).`);
  await recoverMissingGuildConfigs();
  console.log(`Configured ${getEnabledGuilds().length} server(s) for news.`);
  await refreshNews(false).catch(console.error);
  await schedulerTick();
  setInterval(schedulerTick, 30_000);
});
client.on(Events.GuildCreate, async guild => {
  console.log(`Joined guild ${guild.id} (${guild.name}). Connected guilds: ${client.guilds.cache.size}`);
  const channel = findNewsChannel(guild);
  if (channel && !getGuildConfig(guild.id)) { setGuildChannel(guild.id, channel.id); console.log(`[guild ${guild.id}] Auto-configured #${channel.name}`); }
});
client.on(Events.GuildDelete, guild => removeGuild(guild.id));
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    if (interaction.commandName === "setup") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "You need **Manage Server** permission.", ephemeral: true });
      const channel = interaction.options.getChannel("channel", true);
      if (!isSupportedTextChannel(channel)) return interaction.reply({ content: "Please select a text or announcement channel.", ephemeral: true });
      const guild = interaction.guild || client.guilds.cache.get(interaction.guildId);
      if (!guild) return interaction.reply({ content: "❌ I could not access this server. Please make sure the bot itself is added to the server.", ephemeral: true });
      const me = guild.members.me; if (!me) return interaction.reply({ content: "❌ I could not read my server permissions.", ephemeral: true });
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) return interaction.reply({ content: "I need **View Channel**, **Send Messages**, and **Embed Links** permissions in that channel.", ephemeral: true });
      if (!perms?.has(PermissionFlagsBits.MentionEveryone)) return interaction.reply({ content: "I also need **Mention @everyone, @here, and All Roles** permission.", ephemeral: true });
      setGuildChannel(interaction.guildId, channel.id);
      return interaction.reply({ content: `✅ Setup complete. News channel: ${channel}\n📅 Daily news: **12:00 AM IST (midnight)**\n⏰ Reminder: **15 minutes before news**\n📊 Results: **Auto-post after release**\n📢 Mentions: **@everyone enabled**\n🔴 Source: Forex Factory High Impact`, ephemeral: true });
    }
    if (interaction.commandName === "status") {
      const cfg = getGuildConfig(interaction.guildId);
      if (!cfg) return interaction.reply({ content: "❌ This server is not configured. An admin can run `/setup`.", ephemeral: true });
      return interaction.reply({ content: `✅ **Configured**\nChannel: <#${cfg.channel_id}>\nDaily post: **12:00 AM IST (midnight)**\nReminder: **15 minutes before news**\nResults: **Auto-post after release**\nMentions: **@everyone**\nCountdown: **Off**`, ephemeral: true });
    }
    if (interaction.commandName === "testnews") {
      await interaction.deferReply({ ephemeral: true });
      let cfg = getGuildConfig(interaction.guildId);
      if (!cfg) { await recoverMissingGuildConfigs(); cfg = getGuildConfig(interaction.guildId); }
      if (!cfg) return interaction.editReply("Run `/setup` first.");
      await postDailyToGuild(cfg, true);
      return interaction.editReply("✅ Test news post handled in the configured channel with duplicate protection.");
    }
    if (interaction.commandName === "remove") {
      removeGuild(interaction.guildId);
      return interaction.reply({ content: "✅ Forex news alerts have been disabled for this server.", ephemeral: true });
    }
  } catch (err) {
    console.error("Command error:", err);
    const msg = "❌ Something went wrong. Check the bot logs.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});
client.login(process.env.DISCORD_TOKEN);
