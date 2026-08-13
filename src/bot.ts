import { App } from "@slack/bolt"
import { createOpencode, type ToolPart } from "@opencode-ai/sdk"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || ""
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || ""
const APP_TOKEN = process.env.SLACK_APP_TOKEN || ""
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || "1707")
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const USE_REACTIONS = process.env.USE_REACTIONS !== "false"
const LOG_CHANNEL = process.env.LOG_CHANNEL || ""
const MAX_RESPONSE_LEN = 3500
const INSTRUCTIONS_FILE =
  process.env.INSTRUCTIONS_FILE || join(new URL("..", import.meta.url).pathname, "instructions.md")

process.stdout.on("error", () => {})
process.stderr.on("error", () => {})
process.on("SIGPIPE", () => {})

const instructions: string[] = []
try {
  const content = readFileSync(INSTRUCTIONS_FILE, "utf8").trim()
  if (content) {
    instructions.push(content)
    console.log(`📜 Loaded custom instructions from ${INSTRUCTIONS_FILE} (${content.length} chars)`)
  }
} catch {
  console.log(`ℹ️  No instructions file at ${INSTRUCTIONS_FILE} — using defaults`)
}

if (!BOT_TOKEN || !SIGNING_SECRET || !APP_TOKEN) {
  console.error(
    "Missing Slack credentials. Set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN in .env",
  )
  process.exit(1)
}

console.log(`🚀 Starting embedded opencode server on port ${OPENCODE_PORT}...`)
const opencode = await createOpencode({
  port: OPENCODE_PORT,
  timeout: 60_000,
  config: { instructions },
})
console.log(`✅ Opencode server ready at ${opencode.server.url}`)

const shutdown = () => {
  console.log("🛑 Shutting down — closing embedded opencode server...")
  try {
    opencode.server.close()
  } catch (e) {
    console.error(`close error: ${(e as Error).message}`)
  }
  setTimeout(() => process.exit(0), 500)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

const app = new App({
  token: BOT_TOKEN,
  signingSecret: SIGNING_SECRET,
  socketMode: true,
  appToken: APP_TOKEN,
})

let botUserId = ""
let teamId = ""
try {
  const auth = await app.client.auth.test()
  botUserId = auth.user_id || ""
  teamId = auth.team_id || ""
  console.log(`✅ Authenticated as ${auth.user || "?"} (${botUserId}) in team ${teamId}`)
} catch (e) {
  console.error(`⚠️ auth.test failed: ${(e as Error).message}`)
}

type Session = {
  sessionId: string
  channel: string
  thread: string
  userId: string
  createdAt: number
  streamTs?: string
  streamStartPromise?: Promise<void>
  toolLog: string[]
  flushTimer?: ReturnType<typeof setTimeout>
}
const sessions = new Map<string, Session>()
const active = new Map<string, AbortController>()
const paused = new Map<string, { session: Session; messageTs: string }>()

function stripMentions(raw: string) {
  return raw.replace(/<@[A-Z0-9]+>/g, "").trim()
}

function directlyMentionsBot(raw: string) {
  return botUserId ? raw.includes(`<@${botUserId}>`) : false
}

function isAllowed(userId: string) {
  if (!userId) return true
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId)
}

const userNames = new Map<string, string>()
async function userName(userId: string): Promise<string> {
  if (userNames.has(userId)) return userNames.get(userId) || "someone"
  try {
    const info = await app.client.users.info({ user: userId })
    const name =
      info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.real_name || "someone"
    userNames.set(userId, name)
    return name
  } catch {
    return "someone"
  }
}

function threadLink(channel: string, ts: string) {
  return `https://${teamId}.slack.com/archives/${channel}/p${ts.replace(".", "")}`
}

async function logSlack(message: string) {
  if (!LOG_CHANNEL) return
  try {
    await app.client.chat.postMessage({ channel: LOG_CHANNEL, text: message })
  } catch (e) {
    console.error(`⚠️ logSlack failed: ${(e as Error).message}`)
  }
}

async function slackCall(method: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return (await res.json()) as { ok?: boolean; error?: string; ts?: string; channel?: string }
  } catch (e) {
    console.error(`⚠️ ${method} threw: ${(e as Error).message}`)
    return { ok: false, error: "exception" }
  }
}

async function doStartStream(session: Session) {
  const body: Record<string, unknown> = {
    channel: session.channel,
    thread_ts: session.thread,
    task_display_mode: "timeline",
    chunks: [],
  }
  if (!session.channel.startsWith("D")) {
    body.recipient_user_id = session.userId
    body.recipient_team_id = teamId
  }
  const data = await slackCall("chat.startStream", body)
  if (data.ok && data.ts) {
    session.streamTs = data.ts
  } else {
    console.error(`⚠️ chat.startStream failed: ${data.error}`)
  }
}

async function ensureStream(session: Session) {
  if (session.streamTs) return
  if (!session.streamStartPromise) {
    session.streamStartPromise = doStartStream(session).finally(() => {
      session.streamStartPromise = undefined
    })
  }
  await session.streamStartPromise
}

function scheduleToolFlush(session: Session) {
  if (session.flushTimer) return
  session.flushTimer = setTimeout(() => {
    session.flushTimer = undefined
    void ensureStream(session).then(() => flushToolCard(session))
  }, 500)
}

async function flushToolCard(session: Session) {
  if (!session.streamTs || session.toolLog.length === 0) return
  const data = await slackCall("chat.appendStream", {
    channel: session.channel,
    ts: session.streamTs,
    chunks: [
      {
        type: "task_update",
        id: "tools",
        title: "⚙️ Commands",
        status: "in_progress",
        output: session.toolLog.join("\n"),
      },
    ],
  })
  if (!data.ok) console.error(`⚠️ chat.appendStream failed: ${data.error}`)
}

async function stopStream(session: Session) {
  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    session.flushTimer = undefined
  }
  if (session.streamTs) {
    if (session.toolLog.length > 0) {
      const final = await slackCall("chat.appendStream", {
        channel: session.channel,
        ts: session.streamTs,
        chunks: [
          {
            type: "task_update",
            id: "tools",
            title: "⚙️ Commands",
            status: "complete",
            output: session.toolLog.join("\n"),
          },
        ],
      })
      if (!final.ok) console.error(`⚠️ chat.appendStream failed: ${final.error}`)
    }
    const data = await slackCall("chat.stopStream", {
      channel: session.channel,
      ts: session.streamTs,
    })
    if (!data.ok) console.error(`⚠️ chat.stopStream failed: ${data.error}`)
  }
  session.streamTs = undefined
  session.toolLog = []
}

function onToolPart(part: ToolPart, session: Session) {
  if (part.state.status !== "completed") return
  const state = part.state as any
  let detail = ""
  if (state.input != null) {
    detail = typeof state.input === "string" ? state.input : JSON.stringify(state.input)
  }
  if (!detail) detail = state.title || ""
  session.toolLog.push(`\`${part.tool}\`: ${detail}`)
  scheduleToolFlush(session)
  void logSlack(`🧰 Tool: \`${part.tool}\`\n\`\`\`\n${detail.slice(0, 300)}\n\`\`\``)
}

void (async () => {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part as any
      for (const session of sessions.values()) {
        if (session.sessionId !== part.sessionID) continue
        if (part.type === "tool") {
          onToolPart(part, session)
        }
        break
      }
    }
  }
})()

async function postChunked(text: string, channel: string, thread: string) {
  const chunks: string[] = []
  let rest = text
  while (rest.length > MAX_RESPONSE_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_RESPONSE_LEN)
    if (cut <= 0) cut = rest.lastIndexOf(" ", MAX_RESPONSE_LEN)
    if (cut <= 0) cut = MAX_RESPONSE_LEN
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  for (const chunk of chunks) {
    await app.client.chat.postMessage({ channel, thread_ts: thread, text: chunk })
  }
}

function findOrReuseSession(channel: string, thread: string, userId: string) {
  let session = sessions.get(`${channel}-${thread}`)
  if (session) return { session, channel, thread }

  if (channel.startsWith("D")) {
    for (const s of sessions.values()) {
      if (s.channel === channel) {
        sessions.delete(`${channel}-${s.thread}`)
        s.thread = thread
        sessions.set(`${channel}-${thread}`, s)
        return { session: s, channel, thread }
      }
    }
  } else {
    let best: Session | undefined
    for (const s of sessions.values()) {
      if (s.channel === channel && s.userId === userId && (!best || s.createdAt > best.createdAt)) {
        best = s
      }
    }
    if (best) return { session: best, channel, thread: best.thread }
  }
  return null
}

async function handleIncoming(channel: string, thread: string, userId: string, rawText: string) {
  const text = stripMentions(rawText)
  if (!text) return

  if (text.startsWith("##")) {
    console.log(`🔕 [${channel}-${thread}] ignoring message starting with ##`)
    return
  }
  if (text.startsWith("<>") && !directlyMentionsBot(rawText)) {
    console.log(`🔕 [${channel}-${thread}] ignoring <> message without direct mention`)
    return
  }

  const reused = findOrReuseSession(channel, thread, userId)
  if (reused) {
    channel = reused.channel
    thread = reused.thread
  }
  const key = `${channel}-${thread}`

  if (/^!stop$/i.test(text)) {
    paused.delete(key)
    const ctl = active.get(key)
    if (ctl) {
      const sid = reused?.session?.sessionId
      if (sid) {
        await opencode.client.session
          .abort({ path: { id: sid } })
          .catch(() => {})
      }
      ctl.abort()
      active.delete(key)
      console.log(`⏹ [${key}] stopping current response`)
      void logSlack(`⏹ Stopped a run for ${await userName(userId)} — ${threadLink(channel, thread)}`)
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: "⏹ Stopped." })
        .catch(() => {})
    } else {
      console.log(`🔕 [${key}] !stop but nothing running`)
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: "⏹ Nothing to stop." })
        .catch(() => {})
    }
    return
  }

  if (/^!pause$/i.test(text)) {
    const ctl = active.get(key)
    const session = reused?.session
    if (ctl) {
      const sid = session?.sessionId
      if (sid) {
        await opencode.client.session
          .abort({ path: { id: sid } })
          .catch(() => {})
      }
      ctl.abort()
      active.delete(key)
      console.log(`⏸ [${key}] pausing current response`)
      void logSlack(`⏸ Paused a run for ${await userName(userId)} — ${threadLink(channel, thread)}`)
      const sent = await app.client.chat
        .postMessage({
          channel,
          thread_ts: thread,
          text: "⏸ Paused.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "⏸ Paused." } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "▶️ Resume" },
                  action_id: "resume_btn",
                  value: key,
                },
              ],
            },
          ],
        })
        .catch(() => null)
      if (sent?.ts && session) paused.set(key, { session, messageTs: sent.ts })
    } else {
      console.log(`🔕 [${key}] !pause but nothing running`)
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: "⏸ Nothing to pause." })
        .catch(() => {})
    }
    return
  }

  if (!isAllowed(userId)) {
    console.log(`⛔ Blocked <@${userId}> (not in ALLOWED_USERS)`)
    void logSlack(`⛔ Blocked message from ${await userName(userId)} (not in ALLOWED_USERS) — ${threadLink(channel, thread)}`)
    await app.client.chat
      .postMessage({ channel, thread_ts: thread, text: "⛔ You're not in my allowed user list." })
      .catch(() => {})
    return
  }

  console.log(`📨 [${channel}] <@${userId}> ${text}`)
  void logSlack(`📨 ${await userName(userId)}: ${text.slice(0, 200)} — ${threadLink(channel, thread)}`)
  let session = reused?.session

  if (!session) {
    console.log(`🆕 Creating opencode session for thread ${key}...`)
    void logSlack(`🆕 New session for ${await userName(userId)} — ${threadLink(channel, thread)}`)
    const createResult = await opencode.client.session.create({
      body: { title: `Slack thread ${thread}` },
    })
    if (createResult.error) {
      console.error(`❌ session.create failed: ${JSON.stringify(createResult.error)}`)
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: "Sorry, I couldn't create a session. Try again." })
        .catch(() => {})
      return
    }
    console.log(`✅ Created session ${createResult.data.id}`)
    session = {
      sessionId: createResult.data.id,
      channel,
      thread,
      userId,
      createdAt: Date.now(),
      toolLog: [],
    }
    sessions.set(key, session)

    const shareResult = await opencode.client.session.share({
      path: { id: createResult.data.id },
    })
    if (!shareResult.error && shareResult.data?.share?.url) {
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: shareResult.data.share.url })
        .catch(() => {})
    }
  }

  paused.delete(key)
  await runPrompt(session, text)
}

async function runPrompt(session: Session, text: string) {
  const { channel, thread } = session
  const key = `${channel}-${thread}`
  session.toolLog = []

  let reacted = false
  if (USE_REACTIONS) {
    reacted = !!(await app.client.reactions
      .add({ channel, name: "hourglass_flowing_sand", timestamp: thread })
      .catch(() => null))
  }

  const ctl = new AbortController()
  active.set(key, ctl)
  const startedAt = Date.now()
  try {
    const result = await opencode.client.session.prompt({
      path: { id: session.sessionId },
      body: { parts: [{ type: "text", text }] },
      signal: ctl.signal,
    })
    active.delete(key)
    if (ctl.signal.aborted) {
      await stopStream(session)
      if (reacted) {
        await app.client.reactions
          .remove({ channel, name: "hourglass_flowing_sand", timestamp: thread })
          .catch(() => {})
      }
      return
    }
    if (result.error) {
      console.error(`❌ prompt failed: ${JSON.stringify(result.error)}`)
      await stopStream(session)
      await app.client.chat
        .postMessage({ channel, thread_ts: thread, text: "Sorry, I had trouble processing that." })
        .catch(() => {})
      return
    }
    const parts = result.data.parts || []
    const reply =
      parts
        .filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p: any) => p.text)
        .filter(Boolean)
        .join("\n\n") || "Done — no text response."
    console.log(`💬 Reply (${reply.length} chars)`)
    const toolParts = parts.filter(
      (p: any) => p.type === "tool" && p.state?.status === "completed",
    ).length
    const tools = toolParts || session.toolLog.length
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const tok = (result.data as any).info?.tokens || {}
    const tokens = (tok.input || 0) + (tok.output || 0) + (tok.reasoning || 0)
    await stopStream(session)
    if (reacted) {
      await app.client.reactions
        .remove({ channel, name: "hourglass_flowing_sand", timestamp: thread })
        .catch(() => {})
      await app.client.reactions
        .add({ channel, name: "white_check_mark", timestamp: thread })
        .catch(() => {})
    }
    const footer = `\n\n_⚡ ${elapsed}s · ${tokens.toLocaleString()} tokens · ${tools} tool${
      tools === 1 ? "" : "s"
    }_`
    await postChunked(reply + footer, channel, thread)
    void logSlack(
      `💬 Reply posted (${reply.length} chars · ${elapsed}s · ${tools} tool${tools === 1 ? "" : "s"}) — ${threadLink(channel, thread)}`,
    )
  } catch (e) {
    active.delete(key)
    if (ctl.signal.aborted) {
      console.log(`⏹ [${key}] response stopped`)
      await stopStream(session)
      if (reacted) {
        await app.client.reactions
          .remove({ channel, name: "hourglass_flowing_sand", timestamp: thread })
          .catch(() => {})
      }
      return
    }
    console.error(`💥 prompt threw: ${(e as Error).message}`)
    void logSlack(`❌ Prompt error: ${(e as Error).message.slice(0, 200)} — ${threadLink(channel, thread)}`)
    await stopStream(session)
    await app.client.chat
      .postMessage({ channel, thread_ts: thread, text: `Error: ${(e as Error).message}` })
      .catch(() => {})
  }
}

app.action("resume_btn", async ({ ack, body }) => {
  await ack()
  const b = body as any
  const key = b.actions?.[0]?.value as string | undefined
  if (!key) return
  const entry = paused.get(key)
  paused.delete(key)
  if (!entry) return

  await app.client.chat
    .update({
      channel: b.channel?.id,
      ts: b.message?.ts || entry.messageTs,
      text: "⏸ Paused.",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "⏸ Paused." } }],
    })
    .catch(() => {})
  console.log(`▶️ [${key}] resuming paused response`)
  void logSlack(`▶️ Resumed paused session — ${threadLink(entry.session.channel, entry.session.thread)}`)
  await runPrompt(entry.session, "Continue where you left off.")
})

app.event("app_mention", async ({ event }) => {
  await handleIncoming(event.channel, event.thread_ts || event.ts, event.user, event.text || "")
})

app.event("message", async ({ message }) => {
  const msg = message as any
  if (msg.subtype) return
  if (msg.bot_id || msg.botId) return
  if (msg.user === botUserId) return
  if (!msg.text) return

  if (msg.channel_type === "im") {
    if (directlyMentionsBot(msg.text)) return
    await handleIncoming(msg.channel, msg.thread_ts || msg.ts, msg.user, msg.text)
    return
  }

  if (!msg.thread_ts) return
  if (!sessions.has(`${msg.channel}-${msg.thread_ts}`)) return
  if (directlyMentionsBot(msg.text)) return
  await handleIncoming(msg.channel, msg.thread_ts, msg.user, msg.text)
})

await app.start()
console.log("⚡ Slack bot is running (socket mode). Mention me in a channel or DM me.")
if (LOG_CHANNEL) {
  void logSlack("⚡ Bot started and connected.")
  console.log(`📋 Log channel configured: ${LOG_CHANNEL}`)
}
