import 'dotenv/config';
import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import Database from 'better-sqlite3';
import Parser from 'rss-parser';

const parser = new Parser();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 120);
const DATABASE_FILE = process.env.DATABASE_FILE || './data/streamerbot.db';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

const db = new Database(DATABASE_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  alert_channel_id TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  last_live_id TEXT,
  last_live_at TEXT,
  UNIQUE(guild_id, platform, handle)
);
`);

const upsertGuild = db.prepare(`
INSERT INTO guild_config (guild_id) VALUES (?)
ON CONFLICT(guild_id) DO NOTHING
`);

const setAlertChannel = db.prepare(`
UPDATE guild_config SET alert_channel_id = ? WHERE guild_id = ?
`);

const addSubStmt = db.prepare(`
INSERT INTO subscriptions (guild_id, platform, handle, display_name)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, platform, handle) DO UPDATE SET display_name = excluded.display_name
`);

const removeSubStmt = db.prepare(`
DELETE FROM subscriptions WHERE guild_id = ? AND platform = ? AND handle = ?
`);

const listSubsStmt = db.prepare(`
SELECT platform, handle, display_name FROM subscriptions WHERE guild_id = ? ORDER BY platform, handle
`);

const getGuildConfigStmt = db.prepare(`SELECT alert_channel_id FROM guild_config WHERE guild_id = ?`);
const getAllSubsStmt = db.prepare(`SELECT * FROM subscriptions`);
const updateSubLiveStateStmt = db.prepare(`
UPDATE subscriptions SET last_live_id = ?, last_live_at = ? WHERE id = ?
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Connected to ${client.guilds.cache.size} guild(s).`);
  for (const guild of client.guilds.cache.values()) {
    upsertGuild.run(guild.id);
  }
  scheduleChecks();
});

client.on('guildCreate', (guild) => {
  upsertGuild.run(guild.id);
  console.log(`Joined new guild: ${guild.name} (${guild.id}) - auto-registered config.`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const [command, ...args] = message.content.trim().split(/\s+/);
  const guildId = message.guild.id;
  upsertGuild.run(guildId);

  if (command === '!setchannel') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await message.reply('You need Manage Server permission to configure alerts.');
      return;
    }

    const channel = message.mentions.channels.first();
    if (!channel) {
      await message.reply('Usage: `!setchannel #alerts`');
      return;
    }

    setAlertChannel.run(channel.id, guildId);
    await message.reply(`✅ Alert channel set to ${channel}.`);
    return;
  }

  if (command === '!addstream') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await message.reply('You need Manage Server permission to configure alerts.');
      return;
    }

    const platform = (args[0] || '').toLowerCase();
    const handle = args[1];
    const displayName = args.slice(2).join(' ') || handle;
    if (!['twitch', 'youtube', 'kick', 'facebook'].includes(platform) || !handle) {
      await message.reply('Usage: `!addstream <twitch|youtube|kick|facebook> <handle> [display name]`');
      return;
    }

    addSubStmt.run(guildId, platform, handle, displayName);
    await message.reply(`✅ Added **${platform}** subscription for **${displayName}** (${handle}).`);
    return;
  }

  if (command === '!removestream') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await message.reply('You need Manage Server permission to configure alerts.');
      return;
    }

    const platform = (args[0] || '').toLowerCase();
    const handle = args[1];
    if (!platform || !handle) {
      await message.reply('Usage: `!removestream <platform> <handle>`');
      return;
    }
    const result = removeSubStmt.run(guildId, platform, handle);
    if (result.changes) {
      await message.reply(`✅ Removed **${platform}** subscription for **${handle}**.`);
    } else {
      await message.reply('No matching subscription found.');
    }
    return;
  }

  if (command === '!streams') {
    const subs = listSubsStmt.all(guildId);
    if (!subs.length) {
      await message.reply('No stream subscriptions configured for this server yet.');
      return;
    }

    const lines = subs.map((s) => `• **${s.platform}**: ${s.display_name || s.handle} (${s.handle})`);
    await message.reply(`Current stream subscriptions:\n${lines.join('\n')}`);
    return;
  }

  if (command === '!serverid') {
    await message.reply(`This server ID is: \`${guildId}\``);
    return;
  }

  if (command === '!helpstreams') {
    await message.reply([
      '**StreamerBot commands**',
      '`!setchannel #channel` - set where alerts should be posted',
      '`!addstream <platform> <handle> [name]` - add monitored streamer/page/channel',
      '`!removestream <platform> <handle>` - remove monitored source',
      '`!streams` - list configured sources for this server',
      '`!serverid` - show this server id',
      '',
      'Platform handle formats:',
      '• twitch: login name (example: `ninja`)',
      '• youtube: channel id (example: `UC...`)',
      '• kick: username (example: `xqc`)',
      '• facebook: page id (numeric id)'
    ].join('\n'));
  }
});

let twitchTokenCache = {
  accessToken: null,
  expiresAt: 0
};

async function getTwitchAppToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  const now = Date.now();
  if (twitchTokenCache.accessToken && twitchTokenCache.expiresAt > now + 60_000) {
    return twitchTokenCache.accessToken;
  }

  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });

  if (!resp.ok) throw new Error(`Twitch auth failed: ${resp.status}`);
  const data = await resp.json();
  twitchTokenCache.accessToken = data.access_token;
  twitchTokenCache.expiresAt = now + (data.expires_in * 1000);
  return data.access_token;
}

async function checkTwitch(handle) {
  const token = await getTwitchAppToken();
  if (!token) return null;

  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(handle)}`, {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`Twitch stream check failed: ${res.status}`);
  const data = await res.json();
  const stream = data.data?.[0];
  if (!stream) return null;
  return {
    liveId: stream.id,
    startedAt: stream.started_at,
    url: `https://twitch.tv/${handle}`,
    title: stream.title || `${handle} is live on Twitch!`
  };
}

async function checkYouTube(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const feed = await parser.parseURL(feedUrl);
  const latest = feed.items?.[0];
  if (!latest) return null;

  const maybeLive = (latest.title || '').toLowerCase().includes('live')
    || (latest.link || '').includes('/live');

  if (!maybeLive) return null;

  return {
    liveId: latest.id || latest.link,
    startedAt: latest.pubDate || new Date().toISOString(),
    url: latest.link,
    title: latest.title || `YouTube stream is live (${channelId})`
  };
}

async function checkKick(username) {
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`Kick check failed: ${res.status}`);
  const data = await res.json();

  const isLive = data?.livestream?.is_live;
  if (!isLive) return null;

  const liveId = String(data.livestream?.id || data.livestream?.slug || Date.now());
  return {
    liveId,
    startedAt: data.livestream?.start_time || new Date().toISOString(),
    url: `https://kick.com/${username}`,
    title: data.livestream?.session_title || `${username} is live on Kick!`
  };
}

async function checkFacebook(pageId) {
  if (!FACEBOOK_ACCESS_TOKEN) return null;
  const url = new URL(`https://graph.facebook.com/v22.0/${pageId}/live_videos`);
  url.searchParams.set('status', 'LIVE_NOW');
  url.searchParams.set('access_token', FACEBOOK_ACCESS_TOKEN);
  url.searchParams.set('fields', 'id,title,creation_time,permalink_url');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Facebook check failed: ${res.status}`);
  const data = await res.json();
  const live = data?.data?.[0];
  if (!live) return null;

  return {
    liveId: String(live.id),
    startedAt: live.creation_time || new Date().toISOString(),
    url: live.permalink_url || `https://facebook.com/${pageId}`,
    title: live.title || `Facebook page ${pageId} is live!`
  };
}

async function checkStream(platform, handle) {
  switch (platform) {
    case 'twitch':
      return checkTwitch(handle);
    case 'youtube':
      return checkYouTube(handle);
    case 'kick':
      return checkKick(handle);
    case 'facebook':
      return checkFacebook(handle);
    default:
      return null;
  }
}

async function runChecks() {
  const subscriptions = getAllSubsStmt.all();
  for (const sub of subscriptions) {
    try {
      const live = await checkStream(sub.platform, sub.handle);
      if (!live) continue;
      if (sub.last_live_id === live.liveId) continue;

      const guildConfig = getGuildConfigStmt.get(sub.guild_id);
      if (!guildConfig?.alert_channel_id) continue;

      const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
      if (!guild) continue;
      const channel = await guild.channels.fetch(guildConfig.alert_channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const mention = sub.display_name || sub.handle;
      await channel.send(`🔴 **${mention}** is LIVE on **${sub.platform.toUpperCase()}**!\n${live.title}\n${live.url}`);
      updateSubLiveStateStmt.run(live.liveId, live.startedAt, sub.id);
      console.log(`Alert sent for ${sub.platform}:${sub.handle} in guild ${sub.guild_id}`);
    } catch (err) {
      console.error(`Check failed for ${sub.platform}:${sub.handle} (guild ${sub.guild_id})`, err.message);
    }
  }
}

function scheduleChecks() {
  runChecks();
  setInterval(runChecks, CHECK_INTERVAL_SECONDS * 1000);
}

client.login(DISCORD_TOKEN);
