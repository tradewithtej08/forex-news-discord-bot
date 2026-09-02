import "dotenv/config";
import { Client, GatewayIntentBits, Events, EmbedBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
import { DateTime } from "luxon";
import { setGuildChannel, getGuildConfig, getEnabledGuilds, removeGuild, wasSent, markSent, cleanupOldAlerts, saveNewsCache, loadNewsCache } from "./db.js";
import { getTodayEvents, buildDailyEmbeds } from "./news.js";

const IST = "Asia/Kolkata";
const NEWS_CACHE_MS = 30 * 60 * 1000;
if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in environment variables");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let cache = { date: null, events: [], warnings: [], fetchedAt: null, fromFallback: false };
let tickRunning = false;

function asEmbed(data) { return new EmbedBuilder(data); }
function everyonePayload(embed) { return { content: "@everyone", embeds: [asEmbed(embed)], allowedMentions: { parse: ["everyone"] } }; }
function isSupportedTextChannel(channel) { return channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type); }
function normalizeChannelName(name = "") { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function findNewsChannel(guild) {
  const preferred = ["red-folder-news", "redfoldernews", "forex-news", "news"];
  const channels = [...guild.channels.cache.values()].filter(isSupportedTextChannel);
  return channels.find(ch => preferred.includes(normalizeChannelName(ch.name))) || null;
}

async function recoverMissingGuildConfigs() {
  let recovered = 0;
  for (const guild of client.guilds.cache.values()) {
    if (getGuildConfig(guild.id)) continue;
    const channel = findNewsChannel(guild);
    if (!channel) { console.warn(`[guild ${guild.id}] No saved config and no #red-folder-news style channel found.`); continue; }
    setGuildChannel(guild.id, channel.id);
    recovered += 1;
    console.log(`[guild ${guild.id}] Recovered news config -> #${channel.name}`);
  }
  return recovered;
}

async function refreshNews(force = false) {
  const now = DateTime.now().setZone(IST);
  const today = now.toISODate();
  const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt) > NEWS_CACHE_MS || cache.date !== today;
  if (!force && !stale) return cache;
  const previous = cache;
  const result = await getTodayEvents();
  if (result.warnings.length) {
    console.warn("[news warnings]", result.warnings);
    if (previous.date === today && previous.events.length) {
      cache = { ...previous, warnings: result.warnings, fetchedAt: Date.now(), fromFallback: true };
      return cache;
    }
    const stored = loadNewsCache(today);
    if (stored?.events?.length) {
      cache = { date: today, events: stored.events, warnings: result.warnings, fetchedAt: Date.now(), fromFallback: true };
      return cache;
    }
    cache = { date: today, events: [], warnings: result.warnings, fetchedAt: Date.now(), fromFallback: false };
    return cache;
  }
  cache = { date: today, events: result.events, warnings: [], fetchedAt: Date.now(), fromFallback: false };
  saveNewsCache(today, result.events);
  return cache;
}

async function resolveConfiguredChannel(config) {
  try {
    const guild = client.guilds.cache.get(config.guild_id);
    if (!guild) { console.warn(`[guild ${config.guild_id}] Bot is not currently in this guild; skipping.`); return null; }
    let channel = guild.channels.cache.get(config.channel_id) || null;
    if (!channel) channel = await guild.channels.fetch(config.channel_id).catch(() => null);
    if (!isSupportedTextChannel(channel)) {
      const fallback = findNewsChannel(guild);
      if (fallback) {
        setGuildChannel(guild.id, fallback.id);
        console.log(`[guild ${guild.id}] Recovered missing channel -> #${fallback.name}`);
        return fallback;
      }
      console.warn(`[guild ${guild.id}] Configured channel unavailable and no fallback found.`);
      return null;
    }
    return channel;
  } catch (err) { console.error(`[guild ${config.guild_id}] Channel resolve failed:`, err); return null; }
}

async function postDailyToGuild(config, forcePost = false) {
  const now = DateTime.now().setZone(IST);
  const alertType = `daily-${now.toISODate()}`;
  if (!forcePost && wasSent(config.guild_id, now.toISODate(), alertType)) return;
  const channel = await resolveConfiguredChannel(config);
  if (!channel) return;
  const { events, warnings, fromFallback } = await refreshNews(false);
  const embeds = buildDailyEmbeds(events, now);
  for (let i = 0; i < embeds.length; i++) {
    if (i === 0) await channel.send(everyonePayload(embeds[i]));
    else await channel.send({ embeds: [asEmbed(embeds[i])] });
  }
  console.log(`[guild ${config.guild_id}] Daily news posted to #${channel.name}`);
  if (warnings.length) console.warn(`[${config.guild_id}] source warnings:`, warnings);
  if (fromFallback) console.warn(`[${config.guild_id}] Posted cached Forex Factory data because live fetch was unavailable.`);
  if (!forcePost) markSent(config.guild_id, now.toISODate(), alertType);
}

async function schedulerTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = DateTime.now().setZone(IST);
    if (now.minute === 55) await recoverMissingGuildConfigs();
    if (now.hour === 6 && now.minute >= 50) await refreshNews(false);
    if (now.hour === 7 && now.minute === 0) {
      await recoverMissingGuildConfigs();
      await refreshNews(false);
      const currentConfigs = getEnabledGuilds();
      console.log(`[daily] ${currentConfigs.length} configured server(s), ${client.guilds.cache.size} connected server(s).`);
      for (const config of currentConfigs) {
        try { await postDailyToGuild(config); }
        catch (err) { console.error("Daily post failed:", config.guild_id, err); }
      }
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
  if (channel && !getGuildConfig(guild.id)) {
    setGuildChannel(guild.id, channel.id);
    console.log(`[guild ${guild.id}] Auto-configured #${channel.name}`);
  }
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
      const me = guild.members.me;
      if (!me) return interaction.reply({ content: "❌ I could not read my server permissions. Please check the bot role and try again.", ephemeral: true });
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) return interaction.reply({ content: "I need **View Channel**, **Send Messages**, and **Embed Links** permissions in that channel.", ephemeral: true });
      if (!perms?.has(PermissionFlagsBits.MentionEveryone)) return interaction.reply({ content: "I also need **Mention @everyone, @here, and All Roles** permission in that channel so news alerts can ping everyone.", ephemeral: true });
      setGuildChannel(interaction.guildId, channel.id);
      console.log(`[guild ${interaction.guildId}] /setup saved #${channel.name}`);
      return interaction.reply({ content: `✅ Setup complete. News channel: ${channel}\n📅 Daily news: **7:00 AM IST**\n⏰ Reminders: **Off**\n📢 Mentions: **@everyone enabled**\n🔴 Source: Forex Factory High Impact`, ephemeral: true });
    }
    if (interaction.commandName === "status") {
      const cfg = getGuildConfig(interaction.guildId);
      if (!cfg) return interaction.reply({ content: "❌ This server is not configured. An admin can run `/setup`.", ephemeral: true });
      return interaction.reply({ content: `✅ **Configured**\nChannel: <#${cfg.channel_id}>\nDaily post: **7:00 AM IST**\nReminders: **Off**\nMentions: **@everyone**\nCountdown: **Off**\nNews Live alert: **Off**`, ephemeral: true });
    }
    if (interaction.commandName === "testnews") {
      await interaction.deferReply({ ephemeral: true });
      let cfg = getGuildConfig(interaction.guildId);
      if (!cfg) { await recoverMissingGuildConfigs(); cfg = getGuildConfig(interaction.guildId); }
      if (!cfg) return interaction.editReply("Run `/setup` first.");
      await postDailyToGuild(cfg, true);
      return interaction.editReply("✅ Test news post sent to the configured channel with @everyone.");
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
