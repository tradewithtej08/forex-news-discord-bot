import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and CLIENT_ID are required in environment variables");
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set the channel where economic news alerts will be posted.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("News alert channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this server's forex news bot configuration."),
  new SlashCommandBuilder()
    .setName("testnews")
    .setDescription("Post today's high-impact news now for testing.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Disable and remove this server's news bot configuration.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

console.log("Registering global slash commands...");
await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
console.log("Done. Global commands can take some time to appear on all Discord servers.");
