import { createServer } from "node:http"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { join, extname } from "node:path"
import { createHmac, randomBytes } from "node:crypto"

const ROOT = new URL("..", import.meta.url).pathname
const PUBLIC_DIR = join(ROOT, "public")
const BOT_SCRIPT = join(ROOT, "src", "bot.ts")
const PID_FILE = join(ROOT, ".bot.pid")
const STATE_FILE = join(ROOT, ".state.json")
const PORT = Number(process.env.DASHBOARD_PORT || "8787")
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || "1707")
const MAX_LOGS = 2000

const PIN = process.env.DASHBOARD_PIN || ""
const SESSION_SECRET = PIN
  ? createHmac("sha256", "opencode-slack-dashboard").update(PIN).digest("hex")
  : randomBytes(32).toString("hex")
const COOKIE_NAME = "ocdash_session"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

type LogEntry = { id: number; at: string; level: "info" | "warn" | "error"; line: string }
const logs: LogEntry[] = []
let nextLogId = 1
let currentId = 0
const listeners = new Set<(event: string) => void>()

function log(level: LogEntry["level"], line: string) {
  const entry = { id: nextLogId++, at: new Date().toLocaleTimeString(), level, line }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
  for (const send of listeners) {
    send(`data: ${JSON.stringify({ type: "log", entry })}\n\n`)
  }
}

function emit(event: object) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const send of listeners) send(payload)
}

function state(): { autoStart: boolean } {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as { autoStart: boolean }
  } catch {
    return { autoStart: false }
  }
}

function saveState(s: { autoStart: boolean }) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

function sessionToken() {
  return createHmac("sha256", SESSION_SECRET).update("dashboard-session").digest("hex")
}

function hasValidSession(req: { headers: { cookie?: string } }) {
  if (!PIN) return true
  const cookie = req.headers.cookie || ""
  const token = sessionToken()
  return cookie.split(";").some((c) => {
    const eq = c.indexOf("=")
    if (eq === -1) return false
    const name = c.slice(0, eq).trim()
    const value = c.slice(eq + 1).trim()
    return name === COOKIE_NAME && value === token
  })
}

function parseJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on("error", reject)
  })
}

let bot: ChildProcess | null = null
let startedAt: number | null = null
let intentionallyStopped = false
let crashCount = 0

function readPidInfo(): { pid: number; startedAt: number } | null {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { pid: number; startedAt: number }
    if (Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed
  } catch {}
  return null
}
function freePort(port: number) {
  const listening = () => {
    try {
      execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", timeout: 3000 })
      return true
    } catch {
      return false
    }
  }
  const pids = (() => {
    try {
      return execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", timeout: 3000 })
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  })()
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM")
      log("warn", `Freed port ${port}: SIGTERM to stale PID ${pid}`)
    } catch {}
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && listening()) Bun.sleepSync(200)
  if (!listening()) return
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", timeout: 3000 })
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    for (const pid of out) {
      try {
        process.kill(Number(pid), "SIGKILL")
        log("warn", `Freed port ${port}: SIGKILL to stale PID ${pid}`)
      } catch {}
    }
  } catch {}
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function botProcessAlive(pid: number): boolean {
  if (!processAlive(pid)) return false
  try {
    const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 3000,
    })
    return out.includes("opencode-slack") && out.includes("src/bot.ts")
  } catch {
    return false
  }
}

function writePid(pid: number) {
  writeFileSync(PID_FILE, JSON.stringify({ pid, startedAt: Date.now() }))
}

function clearPid() {
  if (existsSync(PID_FILE)) writeFileSync(PID_FILE, "")
}

function statusSnapshot() {
  const pid = bot?.pid ?? null
  return {
    running: !!pid && processAlive(pid),
    pid,
    startedAt: bot ? startedAt : null,
    logCount: logs.length,
    autoStart: state().autoStart,
  }
}

function startBot() {
  if (bot) {
    log("warn", "start requested but bot already running")
    return false
  }
  const info = readPidInfo()
  if (info && botProcessAlive(info.pid)) {
    log("warn", `Bot already running (PID ${info.pid}) — not starting a second one.`)
    return false
  }
  if (info) clearPid()

  freePort(OPENCODE_PORT)
  log("info", "🚀 Starting Slack bot...")
  bot = spawn("bun", ["run", BOT_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  startedAt = Date.now()
  intentionallyStopped = false
  crashCount = 0

  if (bot.pid) {
    writePid(bot.pid)
    log("info", `Spawned bot process PID ${bot.pid}`)
  }

  bot.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) log("info", line)
    }
  })
  bot.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) log("error", line)
    }
  })
  bot.on("exit", (code, signal) => {
    log("warn", `Bot exited (code=${code}, signal=${signal})`)
    clearPid()
    const wasIntentional = intentionallyStopped
    bot = null
    startedAt = null
    emit({ type: "status", status: statusSnapshot() })
    if (!wasIntentional && state().autoStart && crashCount < 5) {
      crashCount++
      log("info", `Auto-restarting bot in 5s (attempt ${crashCount}/5)...`)
      setTimeout(() => {
        log("info", "Auto-restart: starting bot")
        startBot()
      }, 5000).unref()
    } else {
      if (!wasIntentional) log("warn", "Bot stopped unexpectedly — check the logs above.")
      crashCount = 0
    }
  })

  emit({ type: "status", status: statusSnapshot() })
  return true
}

function stopBot() {
  if (bot) {
    intentionallyStopped = true
    log("info", "Stopping bot...")
    bot.kill("SIGTERM")
    setTimeout(() => {
      if (bot) bot.kill("SIGKILL")
    }, 8000).unref()
    return true
  }
  const info = readPidInfo()
  if (info && botProcessAlive(info.pid)) {
    intentionallyStopped = true
    log("info", `Killing adopted bot process ${info.pid}...`)
    try {
      process.kill(info.pid, "SIGTERM")
    } catch {}
    return true
  }
  log("warn", "stop requested but bot not running")
  return false
}

function configSnapshot() {
  return {
    slackBotToken: !!process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: !!process.env.SLACK_SIGNING_SECRET,
    slackAppToken: !!process.env.SLACK_APP_TOKEN,
    opencodePort: Number(process.env.OPENCODE_PORT || "1707"),
    allowedUsers: (process.env.ALLOWED_USERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dashboardPort: PORT,
    pinEnabled: !!PIN,
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await parseJsonBody(req)
    if (!PIN || body?.pin === PIN) {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `${COOKIE_NAME}=${sessionToken()}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`,
      })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid pin" }))
    }
    return
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; Max-Age=0; Path=/`,
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (PIN && !hasValidSession(req)) {
    const serveLogin = url.pathname === "/login" || url.pathname === "/login.html"
    if (serveLogin && req.method === "GET") {
      res.writeHead(200, { "content-type": MIME[".html"] })
      res.end(readFileSync(join(PUBLIC_DIR, "login.html")))
      return
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
    } else {
      res.writeHead(302, { Location: "/login" })
      res.end()
    }
    return
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: statusSnapshot(), config: configSnapshot() }))
    return
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    startBot()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, status: statusSnapshot() }))
    return
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    stopBot()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, status: statusSnapshot() }))
    return
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const autoStart = url.searchParams.get("autoStart")
    if (autoStart !== null) {
      const s = state()
      s.autoStart = autoStart === "1" || autoStart === "true"
      saveState(s)
      log("info", `autoStart set to ${s.autoStart}`)
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, config: configSnapshot(), autoStart: state().autoStart }))
    return
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    const after = Number(url.searchParams.get("after") || "0")
    const entries = logs.filter((l) => l.id > after)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ entries, lastId: logs.length ? logs[logs.length - 1].id : 0 }))
    return
  }

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.write(`data: ${JSON.stringify({ type: "hello", status: statusSnapshot() })}\n\n`)
    const send = (e: string) => res.write(e)
    listeners.add(send)
    req.on("close", () => listeners.delete(send))
    return
  }

  const filePath = url.pathname === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, url.pathname)
  if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" })
    res.end(readFileSync(filePath))
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(PORT, () => {
  log("info", `📊 Dashboard listening on http://localhost:${PORT}`)
  if (PIN) {
    log("info", "🔒 PIN authentication enabled")
  } else {
    log("warn", "⚠️  DASHBOARD_PIN is not set — the dashboard has NO authentication. Set a PIN in .env before exposing it via the tunnel.")
  }
  const info = readPidInfo()
  if (info && botProcessAlive(info.pid)) {
    log("info", `Reclaiming orphaned bot (PID ${info.pid}) from a previous dashboard instance...`)
    try {
      process.kill(info.pid, "SIGTERM")
    } catch {}
    clearPid()
    setTimeout(() => {
      if (state().autoStart && !bot) startBot()
    }, 3000).unref()
  } else {
    if (info) clearPid()
    if (state().autoStart) {
      log("info", "autoStart enabled — launching bot")
      startBot()
    } else {
      log("info", "Bot is stopped. Start it from the dashboard.")
    }
  }
  currentId = nextLogId - 1
})
