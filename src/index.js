import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";
import { DateTime } from "luxon";
import {
  setGuildChannel,
  getGuildConfig,
  getEnabledGuilds,
  removeGuild,
  wasSent,
  markSent,
  cleanupOldAlerts,
  saveNewsCache,
  loadNewsCache
} from "./db.js";
import {
  getTodayEvents,
  buildDailyEmbeds,
  buildReminderEmbed
} from "./news.js";

const IST = "Asia/Kolkata";
const NEWS_CACHE_MS = 30 * 60 * 1000;

if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in environment variables");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let cache = { date: null, events: [], warnings: [], fetchedAt: null, fromFallback: false };
let tickRunning = false;

function asEmbed(data) {
  return new EmbedBuilder(data);
}

function everyonePayload(embed) {
  return {
    content: "@everyone",
    embeds: [asEmbed(embed)],
    allowedMentions: { parse: ["everyone"] }
  };
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
      cache = {
        ...previous,
        warnings: result.warnings,
        fetchedAt: Date.now(),
        fromFallback: true
      };
      console.warn(`[news cache] Using in-memory fallback with ${cache.events.length} event(s).`);
      return cache;
    }

    const stored = loadNewsCache(today);
    if (stored?.events?.length) {
      cache = {
        date: today,
        events: stored.events,
        warnings: result.warnings,
        fetchedAt: Date.now(),
        fromFallback: true
      };
      console.warn(`[news cache] Using persistent fallback with ${cache.events.length} event(s).`);
      return cache;
    }

    cache = {
      date: today,
      events: [],
      warnings: result.warnings,
      fetchedAt: Date.now(),
      fromFallback: false
    };
    return cache;
  }

  cache = {
    date: today,
    events: result.events,
    warnings: [],
    fetchedAt: Date.now(),
    fromFallback: false
  };
  saveNewsCache(today, result.events);
  return cache;
}

async function resolveConfiguredChannel(config) {
  try {
    const guild = await client.guilds.fetch(config.guild_id);
    const channel = await guild.channels.fetch(config.channel_id);
    if (!channel?.isTextBased()) return null;
    return channel;
  } catch {
    return null;
  }
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

  if (warnings.length) console.warn(`[${config.guild_id}] source warnings:`, warnings);
  if (fromFallback) console.warn(`[${config.guild_id}] Posted cached Forex Factory data because live fetch was unavailable.`);
  if (!forcePost) markSent(config.guild_id, now.toISODate(), alertType);
}

async function processReminders(config, events, now) {
  const channel = await resolveConfiguredChannel(config);
  if (!channel) return;

  for (const event of events) {
    const mins = event.timeIst.diff(now, "minutes").minutes;
    for (const target of [60, 15]) {
      const due = mins <= target && mins > target - (70 / 60);
      const type = `reminder-${target}`;
      if (due && !wasSent(config.guild_id, event.key, type)) {
        await channel.send(everyonePayload(buildReminderEmbed(event, target)));
        markSent(config.guild_id, event.key, type);
      }
    }
  }
}

async function schedulerTick() {
  if (tickRunning) return;
  tickRunning = true;

  try {
    const now = DateTime.now().setZone(IST);
    if (now.hour === 6 && now.minute >= 50) await refreshNews(false);

    const configs = getEnabledGuilds();
    if (now.hour === 7 && now.minute === 0) {
      await refreshNews(false);
      for (const config of configs) {
        try { await postDailyToGuild(config); }
        catch (err) { console.error("Daily post failed:", config.guild_id, err); }
      }
    }

    const { events } = await refreshNews(false);
    for (const config of configs) {
      try { await processReminders(config, events, now); }
      catch (err) { console.error("Reminder failed:", config.guild_id, err); }
    }

    if (now.hour === 3 && now.minute === 0) cleanupOldAlerts();
  } catch (err) {
    console.error("Scheduler tick failed:", err);
  } finally {
    tickRunning = false;
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Serving ${readyClient.guilds.cache.size} Discord server(s).`);
  await refreshNews(false).catch(console.error);
  await schedulerTick();
  setInterval(schedulerTick, 30_000);
});

client.on(Events.GuildDelete, guild => removeGuild(guild.id));

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  try {
    if (interaction.commandName === "setup") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "You need **Manage Server** permission.", ephemeral: true });
      }

      const channel = interaction.options.getChannel("channel", true);
      if (!channel.isTextBased()) {
        return interaction.reply({ content: "Please select a text or announcement channel.", ephemeral: true });
      }

      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
        return interaction.reply({
          content: "I need **View Channel**, **Send Messages**, and **Embed Links** permissions in that channel.",
          ephemeral: true
        });
      }

      if (!perms?.has(PermissionFlagsBits.MentionEveryone)) {
        return interaction.reply({
          content: "I also need **Mention @everyone, @here, and All Roles** permission in that channel so news alerts can ping everyone.",
          ephemeral: true
        });
      }

      setGuildChannel(interaction.guildId, channel.id);
      return interaction.reply({
        content:
          `✅ Setup complete. News channel: ${channel}\n` +
          `📅 Daily news: **7:00 AM IST**\n` +
          `⏰ Reminders: **1 hour** and **15 minutes** before each event\n` +
          `📢 Mentions: **@everyone enabled**\n` +
          `🔴 Source: Forex Factory High Impact`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "status") {
      const cfg = getGuildConfig(interaction.guildId);
      if (!cfg) return interaction.reply({ content: "❌ This server is not configured. An admin can run `/setup`.", ephemeral: true });
      return interaction.reply({
        content:
          `✅ **Configured**\n` +
          `Channel: <#${cfg.channel_id}>\n` +
          `Daily post: **7:00 AM IST**\n` +
          `Reminders: **1H + 15M**\n` +
          `Mentions: **@everyone**\n` +
          `Countdown: **Off**\n` +
          `News Live alert: **Off**`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "testnews") {
      await interaction.deferReply({ ephemeral: true });
      const cfg = getGuildConfig(interaction.guildId);
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
