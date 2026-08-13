# ⚡ OpenCode Slack Bot

A Slack bot that runs **opencode** — an open-source AI coding agent — on your own server and lets you talk to it from Slack. Mention it in a channel or DM it, and it answers in Slack threads like a real teammate. It can read and edit files, run commands, and browse your projects, because it *is* a real coding agent running locally.

Also includes a small web dashboard to start / stop the bot, watch its live logs, and toggle auto-start — it binds to `0.0.0.0` and is PIN-protected, so you can point a subdomain at it (e.g. a Hack Club Nest auto-proxy) and control it from anywhere.

---

## ✨ Features

| Feature | What it means |
|---|---|
| 🧵 Threads | `@bot` a question in a channel, or just DM it. Replies appear in the same thread. |
| 💬 Session memory | Every thread keeps its own opencode session, so it remembers context across messages. A new thread = fresh context. |
| ⚙️ "Thinking" cards | While it works, you get a collapsible **⚙️ Commands** card (native Slack Thinking Steps) showing what tools it ran. Click the chevron to expand. |
| ⏹ `!stop` | Stop the current response mid-way. It aborts the run server-side so the next message is instant. |
| ⏸ `!pause` | Pause the current response. A **▶️ Resume** button appears; click it to keep going in the same session. The button disappears after you click it. |
| 🔒 Access control | Restrict who may use the bot with `ALLOWED_USERS`. |
| 📋 Log channel | Set `LOG_CHANNEL` and every event (new session, tool calls, replies, errors) is posted there — plain text, never mentions anyone. |
| 🔌 MCP servers | Any MCP server you configure for opencode (GitHub, databases, browsers…) works through the bot automatically. See [docs/mcp.md](docs/mcp.md). |
| 📊 Dashboard | Start/stop the bot, live logs, auto-start toggle — all in a little web page. |
| 🔐 PIN gate | Protect the dashboard with a PIN before exposing it on the internet. |
| 🚀 Always-on | Runs as a `systemd` service with `Restart=always`: boots at startup and comes back after any crash. |
| 🛡️ Safety rails | `##`-prefixed messages are always ignored. `<>`-prefixed messages are ignored unless you mention the bot. |

---

## 🧠 How it works

```
You (@bot in Slack)
   │  (Socket Mode, no public IP needed)
   ▼
Slack bot  ──►  embedded opencode server (local, port 1707)
                   │
                   ▼
          opencode agent (your local files, tools, model)
```

The bot uses **Slack Socket Mode**, so Slack talks to your server over an *outgoing* WebSocket connection — **you don't need a public IP address or port forwarding for the bot to work**. The dashboard binds to `0.0.0.0`, so you can expose it with any reverse proxy or the port-mapping feature your host provides (e.g. a Hack Club Nest subdomain).

---

## 🧰 Prerequisites (do these once)

On your server (a Hack Club Nest, a VPS, any Linux box — or your own computer for testing):

1. **Install Bun** (JavaScript runtime):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
2. **Install opencode** (the AI agent the bot wraps):
   ```bash
   curl -fsSL https://opencode.ai/install | bash
   ```
   Then log in so it can talk to a model:
   ```bash
   opencode auth login
   ```
3. **Install Git** (usually already there — check with `git --version`).

That's it. No other software needed.

---

## 🛠️ Part 1 — Create the Slack app (browser, ~10 min, once)

The bot runs as a Slack app you create yourself. Do this in your web browser:

1. Go to **https://api.slack.com/apps**
2. Click **Create New App** → **From an app manifest** (or "From scratch" — either works).
3. Pick your workspace, then give it a name like `My OpenCode Bot`.
4. **Enable Socket Mode**:
   - In the left sidebar click **Socket Mode** → toggle it **On**.
   - Click **Generate Token** (scope `connections:write`) → copy the **`xapp-...`** token somewhere safe (you'll need it in Part 3).
5. **Add permissions**:
   - Left sidebar → **OAuth & Permissions** → under **Scopes → Bot Token Scopes** click **Add an OAuth Scope** and add ALL of these:
      - `chat:write`
      - `app_mentions:read`
      - `channels:history`
      - `groups:history`
      - `im:history`
      - `reactions:write` *(optional — only if you want the ⏳/✅ reactions)*
      - `users:read` *(recommended — lets the log channel show real names instead of "someone")*
6. **Subscribe to events**:
   - Left sidebar → **Event Subscriptions** → toggle **Enable Events** **On**.
   - Under **Subscribe to bot events** → **Add Bot User Event** and add:
     - `app_mention`
     - `message.im`
7. **Install the app**:
   - Left sidebar → **OAuth & Permissions** → click **Install to Workspace** → **Allow**.
   - Copy the **Bot User OAuth Token** (starts with **`xoxb-`**).
8. **Grab the Signing Secret**:
   - Left sidebar → **Basic Information** → find **App Credentials** → copy **Signing Secret**.
9. (Optional but recommended) Under **App Home** you can set a description and turn on "Always Show My Bot as Online".

You now have three secret values:
- `SLACK_BOT_TOKEN` → the **`xoxb-...`** one
- `SLACK_APP_TOKEN` → the **`xapp-...`** one
- `SLACK_SIGNING_SECRET` → the signing secret

---

## 📦 Part 2 — Get the code (once)

```bash
git clone https://github.com/SmartSparkCoding/opencode-slack.git
cd opencode-slack
bun install
```

---

## 🔑 Part 3 — Configure `.env`

```bash
cp .env.example .env
```

Then open `.env` in any text editor and fill it in:

```ini
# Your Slack tokens from Part 1
SLACK_BOT_TOKEN=xoxb-YOUR-BOT-TOKEN
SLACK_APP_TOKEN=xapp-YOUR-APP-TOKEN
SLACK_SIGNING_SECRET=YOUR-SIGNING-SECRET

# Ports (leave these as-is unless they conflict)
OPENCODE_PORT=1707
DASHBOARD_PORT=8787

# Interface the dashboard binds to (0.0.0.0 = all interfaces, so a subdomain/port-forward can reach it)
HOST=0.0.0.0

# PIN to protect the web dashboard (REQUIRED before exposing it online)
# e.g. DASHBOARD_PIN=1234
DASHBOARD_PIN=

# Optional: only these Slack users may use the bot.
# Format: comma-separated Slack member IDs, e.g. U123ABC,U456DEF
# Leave empty to allow everyone.
ALLOWED_USERS=

# Show ⏳/✅ reactions while working (true/false)
USE_REACTIONS=true

# Optional: send bot log events (new sessions, tool calls, replies, errors)
# to this channel. Plain text only — never mentions users.
# Invite the bot to the channel first. Leave empty to disable.
# Find a channel ID: click the channel name → about → scroll to the bottom.
LOG_CHANNEL=
```

> 💡 **Finding your Slack member ID:** click your avatar in Slack → **Profile** → **⋯** → **Copy member ID** (looks like `U0ABCDEF12`). The bot's member ID is also shown on the App's **Basic Information** page.

---

## ▶️ Part 4 — Run it (first test)

```bash
bun run dashboard
```

- Open **http://localhost:8787** in your browser. (If you set a `DASHBOARD_PIN`, enter it.)
- Click the green **Start** button. Watch the logs until you see:
  `⚡ Slack bot is running (socket mode)` and `Now connected to Slack`.
- In Slack, **invite the bot into a channel**: type `/invite @My OpenCode Bot`.
- Say **`@My OpenCode Bot hello`** in that channel (or DM it directly). 🎉 It should reply in a thread.

**To stop it:** click the red **Stop** button in the dashboard (or press `Ctrl+C` in the terminal where the dashboard runs — but that also stops the dashboard).

---

## 📊 Part 5 — The web dashboard

The dashboard is just a pretty way to manage the bot:

- **Start / Stop** the bot process
- **Live logs** (exactly what the bot prints)
- **Auto-start** toggle — check it so the bot comes back automatically whenever the dashboard starts

---

## 🔌 Connecting MCP servers (optional)

MCP (Model Context Protocol) is the standard way to give coding agents extra tools — GitHub, databases, browsers, your own APIs. Because the bot runs the *same* local opencode as your terminal, **any MCP server you add to opencode works through the bot automatically** (tools appear as `mcp__<server>__<tool>`).

Add them to `opencode.json` (project root or `~/.config/opencode/opencode.json`), then restart the bot from the dashboard. Full instructions, examples, and troubleshooting: **[docs/mcp.md](docs/mcp.md)**.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://your-mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    }
  }
}
```

---

## 🌍 Part 6 — Deploy on a server (e.g. Hack Club Nest)

The bot's Slack connection is an *outgoing* WebSocket, so it works from any always-on machine. For the dashboard to be reachable from outside, give it a public URL with whatever your host provides — Hack Club Nests let you point a subdomain (like `mini-jacob.hackclub.app`) at a local port, so there's **no tunnel or Cloudflare needed**.

> ⚠️ **Before exposing it:** set a real `DASHBOARD_PIN` in `.env`. The dashboard is the only door to starting/stopping the bot and running commands on your server — keep the PIN strong.

1. **Get the code on the server:**

   ```bash
   git clone https://github.com/SmartSparkCoding/opencode-slack.git
   cd opencode-slack
   bun install
   ```

2. **Create `.env`** from `.env.example` and fill in the Slack tokens, `ALLOWED_USERS`, `LOG_CHANNEL`, and a `DASHBOARD_PIN`.

   > ℹ️ **On a Hack Club Nest, port 8787 is already used** by the Nest's status server — set `DASHBOARD_PORT=8788` (or any free port) and remember the port for step 4.

3. **Run it forever with systemd** (restarts automatically on crash and at boot). A ready-to-edit unit ships in `examples/opencode-slack.service`:

   ```bash
   cp examples/opencode-slack.service /etc/systemd/system/opencode-slack.service
   # edit the paths inside if bun/opencode aren't in /root/.bun/bin and /root/.opencode/bin
   systemctl daemon-reload
   systemctl enable --now opencode-slack
   ```

   Useful commands:

   ```bash
   systemctl status opencode-slack                 # is it running?
   systemctl restart opencode-slack                # restart after code/config changes
   journalctl -u opencode-slack -f                 # follow the logs
   ```

4. **Point your subdomain at the dashboard port.** In the Hack Club Nest panel, forward a subdomain (e.g. `mini-jacob.hackclub.app`) to port **`$DASHBOARD_PORT`** (8788 if you changed it). Visit it in a browser — you should see the PIN login page. Done. 🎉

---

## 💬 Using the bot in Slack

| You type | What happens |
|---|---|
| `@bot check my code for bugs` (in a channel) | It starts a session for that thread and replies there. |
| `type normally in a DM` | Same, but in your DM. |
| reply in the same thread | Continues the *same* session — it remembers what you asked. |
| `!stop` | Aborts the current run (server-side too). Replies `⏹ Stopped.` |
| `!pause` | Pauses the run. Shows a **▶️ Resume** button. Click it → the button disappears and it continues the same session. |
| `## anything` | **Always ignored** — useful when the bot shares a channel with other bots/tools. |
| `<> something` | Ignored **unless you @mention the bot** in the same message. |

Each reply ends with a tiny footer: `_⚡ 12.4s · 1,234 tokens · 5 tools_` so you can see how much work each answer took.

---

## 🎨 Customizing the bot

- **Personality & rules** — edit `instructions.md`. It's injected into every opencode session. Restart the bot from the dashboard after editing.
- **Who can use it** — `ALLOWED_USERS` in `.env` (empty = everyone).
- **Log channel** — set `LOG_CHANNEL` in `.env` to stream bot events to a Slack channel (plain text, no mentions).
- **Reactions** — set `USE_REACTIONS=false` to stop the ⏳/✅ emoji.
- **MCP servers** — edit `opencode.json` (see [docs/mcp.md](docs/mcp.md)).
- **Ports** — `OPENCODE_PORT` and `DASHBOARD_PORT` in `.env` if 1707/8787 are taken (8787 is taken on Hack Club Nests).
- **Instructions file path** — `INSTRUCTIONS_FILE` in `.env` to point at a different file.
- **Max reply length** — `MAX_RESPONSE_LEN` at the top of `src/bot.ts` (long answers get split into multiple messages).

---

## 🔐 Security notes

- The dashboard binds to `0.0.0.0`, so anything on the network (or a public subdomain) can reach its login page. **Set a strong `DASHBOARD_PIN`** or it's an open door to running commands on your server.
- The bot can run arbitrary commands on your machine (it's a coding agent — that's the point). Only grant it to people you trust: set `ALLOWED_USERS`.
- `!stop` / `!pause` send a real interrupt to the opencode server, so an aborted run doesn't keep your CPU busy or block the next message.
- The `.env` file holds real secrets — it's git-ignored, never commit it. A committed example lives in `.env.example`.

---

## 🩹 Troubleshooting

| Problem | Fix |
|---|---|
| `Missing Slack credentials` | Fill in all three tokens in `.env`, restart the dashboard. |
| Connected but never replies | Check the **Event Subscriptions** and **Bot Token Scopes** in Part 1 — the bot events `app_mention` and `message.im` must be subscribed. |
| `chat.startStream failed` | The app needs **Agents & AI Apps** (Thinking Steps) enabled — see Slack's app settings; the bot falls back gracefully if unavailable. |
| Log channel shows "someone" instead of names | Add the `users:read` bot scope in Slack, then reinstall the app and restart the bot. |
| Port already in use (`1707` or `8787`) | Change `OPENCODE_PORT` / `DASHBOARD_PORT` in `.env`, or kill the stale process. On a Hack Club Nest, 8787 is taken by the Nest's status server — use `DASHBOARD_PORT=8788`. |
| systemd service won't start | Check `journalctl -u opencode-slack -n 50` — the usual cause is a wrong `bun`/`opencode` path in the unit, or `opencode auth login` not done yet. |
| Bot starts but prompts fail | Run `opencode auth login` on the server (it's a separate machine from your laptop — it needs its own login). |
| Subdomain shows 404 / nothing | Make sure the dashboard is actually listening: `curl http://localhost:$DASHBOARD_PORT/api/status` on the server, then point your Nest subdomain at the *same* port. |
| Reply is super long and cut off | Long replies are split into multiple messages automatically (`MAX_RESPONSE_LEN`). |

---

## 📁 Project layout

```
opencode-slack/
├── src/
│   ├── bot.ts        # the Slack bot (commands, sessions, thinking cards, pause/resume, log channel)
│   └── server.ts     # the web dashboard (start/stop bot, live logs, PIN auth)
├── public/           # dashboard HTML/CSS/JS
├── docs/
│   └── mcp.md        # how to connect MCP servers to opencode (and the bot)
├── examples/         # systemd service unit for always-on deployment
├── instructions.md   # custom instructions injected into every session
├── .env.example      # template for your .env (never commit .env!)
└── package.json
```

## 📄 License

MIT — use it, change it, ship it. See [LICENSE](LICENSE).
