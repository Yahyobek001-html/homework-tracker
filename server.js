import express from "express";
import crypto from "node:crypto";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database layer: SQLite locally, Postgres in the cloud ---
let q, run; // q = select rows, run = insert/update/delete

if (process.env.DATABASE_URL) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  q = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
  run = async (sql, p = []) => {
    let text = toPg(sql);
    const isInsert = /^\s*insert\s+/i.test(text);
    if (isInsert && !/\breturning\b/i.test(text)) text += " RETURNING *";
    const row = (await pool.query(text, p)).rows[0] || {};
    if (isInsert) row.lastInsertRowid = row.id;
    return row;
  };
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      avatar TEXT DEFAULT '',
      theme TEXT DEFAULT 'ocean',
      bio TEXT DEFAULT '',
      bg TEXT DEFAULT '',
      bgcolor TEXT DEFAULT '',
      accent TEXT DEFAULT '',
      lang TEXT DEFAULT 'uz',
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS homework (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      year TEXT NOT NULL,
      subject TEXT DEFAULT '',
      task TEXT DEFAULT '',
      given TEXT DEFAULT '',
      due TEXT DEFAULT '',
      note TEXT DEFAULT '',
      priority INTEGER DEFAULT 0,
      done_at TEXT DEFAULT '',
      done INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS announcement_log (
      id SERIAL PRIMARY KEY,
      author TEXT DEFAULT '',
      text TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS activity (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT now()
    );
  `);
  // migrations for existing databases
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bg TEXT DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'ocean'");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT DEFAULT 'uz'");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bgcolor TEXT DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS accent TEXT DEFAULT ''");
  await pool.query("ALTER TABLE homework ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''");
  await pool.query("ALTER TABLE homework ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE homework ADD COLUMN IF NOT EXISTS done_at TEXT DEFAULT ''");
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const DB_PATH = path.join(process.cwd(), "data.db");
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "");
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      avatar TEXT DEFAULT '',
      theme TEXT DEFAULT 'ocean',
      bio TEXT DEFAULT '',
      bg TEXT DEFAULT '',
      bgcolor TEXT DEFAULT '',
      accent TEXT DEFAULT '',
      lang TEXT DEFAULT 'uz',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS homework (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, year TEXT NOT NULL,
      subject TEXT DEFAULT '', task TEXT DEFAULT '',
      given TEXT DEFAULT '', due TEXT DEFAULT '', note TEXT DEFAULT '', priority INTEGER DEFAULT 0, done_at TEXT DEFAULT '', done INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS announcement_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT DEFAULT '',
      text TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  for (const col of ["bio TEXT DEFAULT ''", "bg TEXT DEFAULT ''", "theme TEXT DEFAULT 'ocean'", "lang TEXT DEFAULT 'uz'", "bgcolor TEXT DEFAULT ''", "accent TEXT DEFAULT ''"]) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {}
  }
  for (const col of ["note TEXT DEFAULT ''", "priority INTEGER DEFAULT 0", "done_at TEXT DEFAULT ''"]) {
    try { db.exec(`ALTER TABLE homework ADD COLUMN ${col}`); } catch {}
  }
  q = (sql, p = []) => db.prepare(sql).all(...p);
  run = (sql, p = []) => {
    const info = db.prepare(sql).run(...p);
    return { lastInsertRowid: info.lastInsertRowid };
  };
}

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(process.cwd(), "public")));

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

async function authUser(req) {
  const token = (req.headers.cookie || "").split(";").map(c => c.trim())
    .find(c => c.startsWith("token="))?.slice(6);
  if (!token) return null;
  const rows = await q("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token = ?", [token]);
  return rows[0] || null;
}

// Creator-only activity feed
async function track(userId, action) {
  try { await run("INSERT INTO activity (user_id, action) VALUES (?,?)", [userId, action]); } catch {}
}

// heartbeat ping (every 60s from the client) so the creator can see who's online
app.post("/api/ping", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await run("DELETE FROM activity WHERE user_id = ? AND action = '__online__'", [user.id]);
  await run("INSERT INTO activity (user_id, action) VALUES (?, '__online__')", [user.id]);
  res.json({ ok: true });
});

// Creator-only: full activity feed + online list
app.get("/api/activity", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can see this." });
  const feed = await q(
    "SELECT activity.id, activity.action, activity.created_at, users.username " +
    "FROM activity JOIN users ON users.id = activity.user_id " +
    "WHERE activity.action <> '__online__' ORDER BY activity.id DESC LIMIT 40");
  const online = await q(
    "SELECT users.username FROM activity JOIN users ON users.id = activity.user_id " +
    "WHERE activity.action = '__online__' ORDER BY activity.id DESC");
  res.json({ online: online.map(r => r.username), feed });
});

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4)
    return res.status(400).json({ error: "Need a username and password (min 4 chars)." });
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const count = await q("SELECT COUNT(*) AS c FROM users");
    const role = Number(count[0].c) === 0 ? "owner" : "student";
    const info = await run("INSERT INTO users (username, password_hash, salt, role) VALUES (?,?,?,?)",
      [username, hash(password, salt), salt, role]);
    const token = crypto.randomBytes(24).toString("hex");
    await run("INSERT INTO sessions (token, user_id) VALUES (?,?)", [token, info.lastInsertRowid]);
    res.setHeader("Set-Cookie", `token=${token}; HttpOnly; Path=/; SameSite=Lax`);
    res.json({ ok: true, role });
  } catch {
    res.status(400).json({ error: "Username already taken." });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const rows = await q("SELECT * FROM users WHERE username = ?", [username]);
  const user = rows[0];
  if (!user || hash(password, user.salt) !== user.password_hash)
    return res.status(401).json({ error: "Wrong username or password." });
  const token = crypto.randomBytes(24).toString("hex");
  await run("INSERT INTO sessions (token, user_id) VALUES (?,?)", [token, user.id]);
  res.setHeader("Set-Cookie", `token=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ ok: true, role: user.role });
});

app.post("/api/logout", async (req, res) => {
  const token = (req.headers.cookie || "").split(";").map(c => c.trim())
    .find(c => c.startsWith("token="))?.slice(6);
  if (token) await run("DELETE FROM sessions WHERE token = ?", [token]);
  res.setHeader("Set-Cookie", "token=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    avatar: user.avatar || "",
    theme: user.theme || "ocean",
    bio: user.bio || "",
    bg: user.bg || "",
    bgcolor: user.bgcolor || "",
    accent: user.accent || "",
    lang: user.lang || "uz"
  });
});

app.patch("/api/me", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { avatar, theme, bio, bg, bgcolor, accent, lang } = req.body || {};
  const HEX = /^#[0-9a-f]{6}$/i;
  if (typeof avatar === "string") {
    if (avatar.length > 2600000) return res.status(400).json({ error: "Image too large (max ~1.8 MB)." });
    await run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, user.id]);
  }
  if (typeof bg === "string") {
    if (bg.length > 5200000) return res.status(400).json({ error: "Background too large (max ~3.5 MB)." });
    await run("UPDATE users SET bg = ? WHERE id = ?", [bg, user.id]);
  }
  if (typeof theme === "string") {
    await run("UPDATE users SET theme = ? WHERE id = ?", [theme, user.id]);
  }
  if (typeof bgcolor === "string") {
    if (bgcolor && !HEX.test(bgcolor)) return res.status(400).json({ error: "Invalid colour." });
    await run("UPDATE users SET bgcolor = ? WHERE id = ?", [bgcolor, user.id]);
  }
  if (typeof accent === "string") {
    if (accent && !HEX.test(accent)) return res.status(400).json({ error: "Invalid colour." });
    await run("UPDATE users SET accent = ? WHERE id = ?", [accent, user.id]);
  }
  if (typeof bio === "string") {
    await run("UPDATE users SET bio = ? WHERE id = ?", [bio.slice(0, 160), user.id]);
  }
  if (typeof lang === "string" && ["en", "uz", "ru", "ar", "es", "fr"].includes(lang)) {
    await run("UPDATE users SET lang = ? WHERE id = ?", [lang, user.id]);
  }
  res.json({ ok: true });
});

// Change display name
app.patch("/api/me/name", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { username, password } = req.body || {};
  const name = (username || "").trim();
  if (name.length < 3) return res.status(400).json({ error: "New name must be at least 3 characters." });
  if (hash(password || "", user.salt) !== user.password_hash)
    return res.status(400).json({ error: "Wrong password." });
  try {
    await run("UPDATE users SET username = ? WHERE id = ?", [name, user.id]);
    res.json({ ok: true, username: name });
  } catch {
    res.status(400).json({ error: "That name is already taken." });
  }
});

// Change password
app.patch("/api/me/password", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { current, next } = req.body || {};
  if (hash(current || "", user.salt) !== user.password_hash)
    return res.status(400).json({ error: "Current password is wrong." });
  if (!next || next.length < 4) return res.status(400).json({ error: "New password must be at least 4 characters." });
  const salt = crypto.randomBytes(16).toString("hex");
  await run("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", [hash(next, salt), salt, user.id]);
  res.json({ ok: true });
});

// Delete own account
app.delete("/api/me", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role === "owner") return res.status(400).json({ error: "The creator account can't be deleted." });
  await run("DELETE FROM homework WHERE user_id = ?", [user.id]);
  await run("DELETE FROM activity WHERE user_id = ?", [user.id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
  await run("DELETE FROM users WHERE id = ?", [user.id]);
  res.setHeader("Set-Cookie", "token=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/announcement", async (req, res) => {
  const rows = await q("SELECT value FROM settings WHERE key = 'announcement'");
  const meta = await q("SELECT author, created_at FROM announcement_log ORDER BY id DESC LIMIT 1");
  res.json({
    text: rows[0] ? rows[0].value : "",
    author: meta[0] ? meta[0].author : "",
    date: meta[0] ? meta[0].created_at : ""
  });
});

app.post("/api/announcement", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can post announcements." });
  const { text } = req.body || {};
  await run(`INSERT INTO settings (key, value) VALUES ('announcement', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [text || ""]);
  await run("INSERT INTO announcement_log (author, text) VALUES (?,?)", [user.username, text || ""]);
  res.json({ ok: true });
});

// Remove the current announcement (creator only)
app.delete("/api/announcement", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can remove announcements." });
  await run("UPDATE settings SET value = '' WHERE key = 'announcement'");
  res.json({ ok: true });
});

// History of past announcements (creator only)
app.get("/api/announcements", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can do this." });
  const rows = await q("SELECT id, author, text, created_at FROM announcement_log ORDER BY id DESC LIMIT 50");
  res.json(rows);
});

app.get("/api/homework", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const rows = await q("SELECT * FROM homework WHERE user_id = ? ORDER BY id", [user.id]);
  res.json(rows.map(r => ({ ...r, done: !!r.done })));
});

app.post("/api/homework", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { year, subject, task, given, due, note, priority } = req.body || {};
  const prio = Math.max(0, Math.min(2, Number(priority) || 0));
  const info = await run("INSERT INTO homework (user_id, year, subject, task, given, due, note, priority) VALUES (?,?,?,?,?,?,?,?)",
    [user.id, year, subject || "", task || "", given || "", due || "", String(note || "").slice(0, 300), prio]);
  await track(user.id, `added ${subject || "new"} homework`);
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/homework/done-all", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const year = (req.body || {}).year || "2026-27";
  const today = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).today || "") ? req.body.today : new Date().toISOString().slice(0, 10);
  await run("UPDATE homework SET done = 1, done_at = ? WHERE user_id = ? AND year = ? AND done = 0", [today, user.id, year]);
  await track(user.id, "completed all homework");
  res.json({ ok: true });
});

app.post("/api/homework/clear-done", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const year = (req.body || {}).year || "2026-27";
  await run("DELETE FROM homework WHERE user_id = ? AND year = ? AND done = 1", [user.id, year]);
  await track(user.id, "cleared completed homework");
  res.json({ ok: true });
});

app.post("/api/homework/delete-many", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.slice(0, 300) : [];
  const clean = ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
  if (!clean.length) return res.json({ ok: true, deleted: 0 });
  const marks = clean.map(() => "?").join(",");
  const found = await q(`SELECT COUNT(*) AS n FROM homework WHERE user_id = ? AND id IN (${marks})`, [user.id, ...clean]);
  await run(`DELETE FROM homework WHERE user_id = ? AND id IN (${marks})`, [user.id, ...clean]);
  await track(user.id, `deleted ${Number(found[0]?.n) || clean.length} homework item(s)`);
  res.json({ ok: true, deleted: Number(found[0]?.n) || 0 });
});

app.get("/api/leaderboard", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const list = await q(`
    SELECT u.id, u.username, u.role, u.avatar,
           COUNT(h.id) AS total,
           COALESCE(SUM(CASE WHEN h.done = 1 THEN 1 ELSE 0 END), 0) AS done
    FROM users u LEFT JOIN homework h ON h.user_id = u.id AND h.year = '2026-27'
    GROUP BY u.id, u.username, u.role, u.avatar
    ORDER BY done DESC, total DESC, u.username ASC`);
  res.json(list.map(r => ({
    id: r.id, username: r.username, role: r.role, avatar: r.avatar || "",
    done: Number(r.done) || 0, total: Number(r.total) || 0
  })));
});

app.patch("/api/homework/:id", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const rows = await q("SELECT * FROM homework WHERE id = ? AND user_id = ?", [req.params.id, user.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.doneAt || "") ? b.doneAt : new Date().toISOString().slice(0, 10);
  const nextDone = "done" in b ? (b.done ? 1 : 0) : row.done;
  const nextDoneAt = nextDone ? (row.done ? (row.done_at || today) : today) : "";
  await run("UPDATE homework SET subject=?, task=?, given=?, due=?, done=?, note=?, priority=?, done_at=? WHERE id=?",
    [b.subject ?? row.subject, b.task ?? row.task, b.given ?? row.given, b.due ?? row.due,
     nextDone,
     ("note" in b ? String(b.note || "").slice(0, 300) : (row.note || "")),
     ("priority" in b ? Math.max(0, Math.min(2, Number(b.priority) || 0)) : (Number(row.priority) || 0)),
     nextDoneAt,
     row.id]);
  if ("done" in b) await track(user.id, (b.done ? "✅ done" : "↩ undone") + ` ${row.subject || ""} homework`);
  res.json({ ok: true });
});

app.delete("/api/homework/:id", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await run("DELETE FROM homework WHERE id = ? AND user_id = ?", [req.params.id, user.id]);
  res.json({ ok: true });
});

app.get("/api/members", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const users = await q("SELECT id, username, role, avatar, bio FROM users ORDER BY id");
  res.json(users);
});

app.get("/api/members/:id/homework", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can do this." });
  const rows = await q("SELECT * FROM homework WHERE user_id = ? ORDER BY id", [req.params.id]);
  res.json(rows.map(r => ({ ...r, done: !!r.done })));
});

app.delete("/api/members/:id", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can do this." });
  if (Number(req.params.id) === user.id) return res.status(400).json({ error: "You cannot delete your own account." });
  await run("DELETE FROM homework WHERE user_id = ?", [req.params.id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [req.params.id]);
  await run("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- AI ASSISTANT ---------------- */
const AI_LANG_NAMES = { uz: "Uzbek (Latin)", en: "English", ru: "Russian", ar: "Arabic", es: "Spanish", fr: "French" };

function aiIntent(text) {
  const s = String(text || "").toLowerCase();
  const has = (words) => words.some(w => s.includes(w));
  if (!s.trim()) return "help";
  if (has(["plan", "reja", "rejalashtir", "план", "расписан", "خطة", "планир", "planifi", "horario", "jadval"])) return "plan";
  if (has(["overdue", "muddati o", "просроч", "متأخر", "atrasad", "retard"])) return "overdue";
  if (has(["tomorrow", "ertaga", "завтра", "غدا", "غدًا", "mañana", "demain"])) return "tomorrow";
  if (has(["left", "qoldi", "qolgan", "nima bor", "остал", "متبق", "pendient", "queda", "restant", "à faire"])) return "left";
  if (has(["tip", "maslahat", "совет", "نصيحة", "consejo", "conseil", "qanday o‘qish", "how to study"])) return "tips";
  if (has(["motiv", "ruhlantir", "мотив", "تحفيز", "motivación", "motivation"])) return "motivation";
  if (has(["help", "yordam", "помощь", "مساعدة", "ayuda", "aide", "nima qila olasan"])) return "help";
  if (has(["hi", "hello", "salom", "assalom", "привет", "здравств", "مرحبا", "السلام", "hola", "bonjour"])) return "greeting";
  return "summary";
}

app.post("/api/ai/chat", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const body = req.body || {};
  const lang = ["uz", "en", "ru", "ar", "es", "fr"].includes(body.lang) ? body.lang : "en";
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";

  const all = await q("SELECT id, subject, task, due, priority, done FROM homework WHERE user_id = ? AND year = '2026-27' ORDER BY id", [user.id]);
  const rows = all.map(r => ({
    id: r.id, subject: r.subject || "", task: r.task || "", due: r.due || "",
    priority: Number(r.priority) || 0, done: !!r.done
  }));
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const clientToday = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today : "";
  const today = clientToday || iso(now);
  const tomorrow = iso(new Date(now.getTime() + 86400000));
  const pending = rows.filter(r => !r.done);
  const overdue = pending.filter(r => r.due && r.due < today);
  const dueTomorrow = pending.filter(r => r.due === tomorrow);
  const todayDue = pending.filter(r => r.due === today);
  const byDue = (a, b) => (a.due || "9999-12-31").localeCompare(b.due || "9999-12-31");
  pending.sort((a, b) => (b.priority - a.priority) || byDue(a, b));
  overdue.sort(byDue);
  dueTomorrow.sort((a, b) => b.priority - a.priority);
  todayDue.sort((a, b) => b.priority - a.priority);

  const counts = { done: rows.filter(r => r.done).length, total: rows.length, pending: pending.length, overdue: overdue.length };

  // 7-day plan: overdue -> today, unscheduled -> spread over the next days
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    days.push({ date: iso(d), items: [] });
  }
  const unscheduled = [];
  for (const r of pending) {
    if (r.due) {
      const slot = days.find(d => d.date === r.due) || days[0];
      slot.items.push(r);
    } else {
      unscheduled.push(r);
    }
  }
  unscheduled.forEach((r, i) => {
    const open = days.slice().sort((a, b) => a.items.length - b.items.length)[i % 7];
    open.items.push(r);
  });

  const kind = ({ motivate: "motivation" })[body.hint] || (["left", "plan", "tomorrow", "overdue", "tips", "motivation", "summary", "help", "greeting"].includes(body.hint) ? body.hint : aiIntent(lastUser));

  // Optional real LLM (OpenAI-compatible). Set AI_API_KEY / OPENAI_API_KEY to enable.
  const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "";
  if (key) {
    const base = process.env.AI_BASE_URL
      || (process.env.OPENROUTER_API_KEY && !process.env.AI_API_KEY ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
    const model = process.env.AI_MODEL || "gpt-4o-mini";
    const context = {
      today, tomorrow,
      counts,
      pending: pending.slice(0, 40).map(r => ({ subject: r.subject, task: r.task, due: r.due, priority: r.priority })),
      overdue: overdue.slice(0, 20).map(r => ({ subject: r.subject, task: r.task, due: r.due })),
      dueTomorrow: dueTomorrow.slice(0, 20).map(r => ({ subject: r.subject, task: r.task }))
    };
    const system = `You are a friendly homework assistant for a class 7-01 student named ${user.username}.
Today is ${today}. Answer in ${AI_LANG_NAMES[lang]}. Be concise (max 130 words), practical and encouraging.
Only use the student's real data below; never invent homework. Use short bullet lines when listing tasks.
If asked for a plan, organise the next 7 days realistically (2-4 short study blocks per day).
Student data JSON: ${JSON.stringify(context)}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 450,
          messages: [{ role: "system", content: system }, ...history]
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (r.ok) {
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === "string" && text.trim()) {
          return res.json({ source: "ai", kind, reply: text.trim(), counts });
        }
      }
    } catch (e) {
      // fall through to the built-in assistant
    }
  }

  res.json({
    source: "smart",
    kind,
    counts,
    data: {
      items: (kind === "overdue" ? overdue : kind === "tomorrow" ? dueTomorrow : pending).slice(0, 20),
      days,
      today, tomorrow
    }
  });
});

app.listen(PORT, () => console.log(`✅ Homework Tracker running at http://localhost:${PORT}`));
