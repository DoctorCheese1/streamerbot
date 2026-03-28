# StreamerBot

A Discord bot that works in **multiple servers** and sends go-live alerts for:
- Twitch
- YouTube
- Kick
- Facebook

It auto-registers each server when the bot joins, stores each guild's server ID/config, and supports per-server stream lists + alert channel.

## Features

- ✅ Multi-server support
- ✅ Auto-add server ID/config when bot joins a server (`guildCreate`)
- ✅ Per-server configuration
- ✅ Commands to add/remove/list monitored streamers/channels/pages
- ✅ Alerts posted to a channel you choose per server

## Commands

- `!setchannel #alerts` — set the alert channel for this server
- `!addstream <twitch|youtube|kick|facebook> <handle> [display name]`
- `!removestream <platform> <handle>`
- `!streams` — list subscriptions for this server
- `!serverid` — show current server ID
- `!helpstreams` — show command help

## Platform handle formats

- Twitch: username (example `ninja`)
- YouTube: channel id, `@handle`, or full channel URL (for example `UC...`, `@StreamerName`, or `https://www.youtube.com/@StreamerName`)
- Kick: username (example `xqc`)
- Facebook: numeric page id

## Requirements

- Node.js 20+
- Discord bot token
- Twitch API credentials (for Twitch checks)
- Facebook Page access token (for Facebook live checks)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env template:
   ```bash
   cp .env.example .env
   ```
3. Fill in `.env` values.
4. Start the bot:
   ```bash
   npm start
   ```

## Environment variables

See `.env.example`:
- `DISCORD_TOKEN`
- `CHECK_INTERVAL_SECONDS` (default: `120`)
- `DATABASE_FILE` (default: `./data/streamerbot.db`)
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `FACEBOOK_ACCESS_TOKEN`

## Notes

- YouTube live detection is based on channel RSS feed's latest item and may not be perfect for every channel workflow.
- Kick API endpoints can change over time.
- Facebook live checks require a valid token with the required permissions for the target pages.
