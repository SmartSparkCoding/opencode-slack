# ⚡ OpenCode Slack Bot

A Slack bot that runs **opencode** — an open-source AI coding agent — on your own computer and lets you talk to it from Slack. Mention it in a channel or DM it, and it answers in Slack threads like a real teammate. It can read and edit files, run commands, and browse your projects, because it *is* a real coding agent running locally.

Also includes a small web dashboard to start / stop the bot, watch its live logs, and toggle auto-start — optionally exposed over the internet through a Cloudflare Tunnel so you can control it from your phone.

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
| 📊 Dashboard | Start/stop the bot, live logs, auto-start toggle — all in a little web page. |
| 🔐 PIN gate | Protect the dashboard with a PIN before exposing it on the internet. |
| 🚀 Always-on | Runs as a macOS `launchd` service: boots at login, restarts if it crashes. |
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

The bot uses **Slack Socket Mode**, so Slack talks to your machine over an *outgoing* WebSocket connection — **you don't need a public IP address or port forwarding for the bot to work**. The Cloudflare Tunnel in this guide is only needed if you also want to reach the web dashboard from outside your home/office network.

---

## 🧰 Prerequisites (do these once)

1. **Install Bun** (JavaScript runtime, one command). Open **Terminal** (press `Cmd+Space`, type "Terminal", hit Enter) and paste:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

   Close and reopen Terminal afterwards.

2. **Install Git** (probably already there — check with `git --version`; if it errors, get it from https://git-scm.com/downloads).

3. **Install Cloudflared** (only needed for the tunnel section):

   ```bash
   brew install cloudflared
   ```

   If `brew` isn't installed, get it from https://brew.sh.

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

# PIN to protect the web dashboard (REQUIRED before exposing it online)
# e.g. DASHBOARD_PIN=1234
DASHBOARD_PIN=

# Optional: only these Slack users may use the bot.
# Format: comma-separated Slack member IDs, e.g. U123ABC,U456DEF
# Leave empty to allow everyone.
ALLOWED_USERS=

# Show ⏳/✅ reactions while working (true/false)
USE_REACTIONS=true
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

## 🌍 Part 6 — Cloudflare Tunnel (optional, control it from anywhere)

The tunnel gives your dashboard a public URL like `https://bot.example.com` so you can start/stop the bot and watch logs from your phone, anywhere. **Nothing about the bot requires this** — only do it if you want remote dashboard access.

> ⚠️ **Before you do this:** set a real `DASHBOARD_PIN` in `.env` and restart the dashboard. Otherwise *anyone* with the URL could control your bot (and your machine).

1. **Log in to Cloudflare:**

   ```bash
   cloudflared tunnel login
   ```

   A browser tab opens — pick the domain you own (any free Cloudflare account works).

2. **Create a tunnel:**

   ```bash
   cloudflared tunnel create opencode-slack
   ```

   This prints a **tunnel UUID** (like `2c5508dd-...`). Write it down.

3. **Create the config file** `~/.cloudflared/opencode-slack.yml`:

   ```yaml
   tunnel: YOUR-TUNNEL-UUID
   credentials-file: /Users/YOURNAME/.cloudflared/YOUR-TUNNEL-UUID.json

   ingress:
     - hostname: bot.example.com
       service: http://localhost:8787
     - service: http_status:404
   ```

   A ready-to-edit copy ships in `examples/cloudflared.yml.example`.

4. **Route your subdomain** (e.g. `bot.example.com`) to the tunnel:

   ```bash
   cloudflared tunnel route dns opencode-slack bot.example.com
   ```

5. **Run it** (in a terminal, just to test):

   ```bash
   cloudflared tunnel run --config ~/.cloudflared/opencode-slack.yml opencode-slack
   ```

   Leave that running and visit **https://bot.example.com** — you should see the dashboard's login page. Enter your PIN. Done. 🎉

   Press `Ctrl+C` to stop the tunnel when you're done testing.

---

## 🔁 Part 7 — Run it forever (auto-start on macOS with launchd)

Right now the dashboard dies if you close the terminal or reboot. This makes both the dashboard (→ bot) and the tunnel (→ public URL) start automatically at login and restart after crashes.

1. **Test that `bun` is on the PATH launchd can see:**
   ```bash
   which bun cloudflared
   ```
   (Write down the full paths — you'll paste them into the plist files.)

2. **Dashboard agent** — copy the template and edit the paths:

   ```bash
   cp examples/launchd-dashboard.plist.example ~/Library/LaunchAgents/com.opencode.slack.dashboard.plist
   ```

   Open `~/Library/LaunchAgents/com.opencode.slack.dashboard.plist`, replace every `/Users/YOURNAME` with your real home folder, and make sure the `bun` path matches `which bun`.

3. **Tunnel agent** (only if you set up the tunnel) — same idea:

   ```bash
   cp examples/launchd-tunnel.plist.example ~/Library/LaunchAgents/com.opencode.slack.tunnel.plist
   ```

4. **Load both:**

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencode.slack.dashboard.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencode.slack.tunnel.plist
   ```

5. **Useful commands:**

   ```bash
   launchctl list | grep opencode          # is it loaded?
   launchctl kickstart -k gui/$(id -u)/com.opencode.slack.dashboard   # restart (after code changes)
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.opencode.slack.dashboard.plist  # stop
   ```

   Log files land in `~/opencode-slack/dashboard.out.log` and `~/.cloudflared/tunnel.err.log`.

> 🐛 **Troubleshooting launchd:** if it doesn't start, the usual cause is a wrong `bun` path or a plist saved with the wrong name. Check the log files listed above, then `launchctl list | grep opencode`.

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
- **Reactions** — set `USE_REACTIONS=false` to stop the ⏳/✅ emoji.
- **Ports** — `OPENCODE_PORT` and `DASHBOARD_PORT` in `.env` if 1707/8787 are taken.
- **Instructions file path** — `INSTRUCTIONS_FILE` in `.env` to point at a different file.
- **Max reply length** — `MAX_RESPONSE_LEN` at the top of `src/bot.ts` (long answers get split into multiple messages).

---

## 🔐 Security notes

- The dashboard is **not** a hardened remote-admin tool. It's meant to run on your own machine/LAN. Only expose it via the tunnel if you set a strong `DASHBOARD_PIN`, and prefer keeping the tunnel to just yourself.
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
| Port already in use (`1707` or `8787`) | Change `OPENCODE_PORT` / `DASHBOARD_PORT` in `.env`, or kill the stale process: `lsof -ti tcp:1707 \| xargs kill`. The dashboard already frees stale bots automatically. |
| launchd won't start | Wrong `bun` path in the plist → run `which bun` and update it. Check `dashboard.err.log`. |
| Tunnel shows 404 / bad gateway | Make sure the dashboard is running on `localhost:8787` and the `ingress` hostname matches what you routed. |
| Reply is super long and cut off | Long replies are split into multiple messages automatically (`MAX_RESPONSE_LEN`). |

---

## 📁 Project layout

```
opencode-slack/
├── src/
│   ├── bot.ts        # the Slack bot (commands, sessions, thinking cards, pause/resume)
│   └── server.ts     # the web dashboard (start/stop bot, live logs, PIN auth)
├── public/           # dashboard HTML/CSS/JS
├── examples/         # launchd plist templates + cloudflared config template
├── instructions.md   # custom instructions injected into every session
├── .env.example      # template for your .env (never commit .env!)
└── package.json
```

## 📄 License

MIT — use it, change it, ship it. See [LICENSE](LICENSE).
