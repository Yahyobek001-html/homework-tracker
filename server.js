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
  run = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0] || {};
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      avatar TEXT DEFAULT '',
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
      done INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
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
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS homework (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, year TEXT NOT NULL,
      subject TEXT DEFAULT '', task TEXT DEFAULT '',
      given TEXT DEFAULT '', due TEXT DEFAULT '', done INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  q = (sql, p = []) => db.prepare(sql).all(...p);
  run = (sql, p = []) => {
    const info = db.prepare(sql).run(...p);
    return { lastInsertRowid: info.lastInsertRowid };
  };
}

app.use(express.json({ limit: '5mb' }));
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

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4)
    return res.status(400).json({ error: "Need a username and password (min 4 chars)." });
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const count = await q("SELECT COUNT(*) AS c FROM users");
    const role = count[0].c === 0 ? "owner" : "student";
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
  res.json({ username: user.username, role: user.role, avatar: user.avatar || "" });
});

app.patch("/api/me", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { avatar } = req.body || {};
  await run("UPDATE users SET avatar = ? WHERE id = ?", [avatar || "", user.id]);
  res.json({ ok: true });
});

app.get("/api/announcement", async (req, res) => {
  const rows = await q("SELECT value FROM settings WHERE key = 'announcement'");
  res.json({ text: rows[0] ? rows[0].value : "" });
});

app.post("/api/announcement", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can post announcements." });
  const { text } = req.body || {};
  await run(`INSERT INTO settings (key, value) VALUES ('announcement', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [text || ""]);
  res.json({ ok: true });
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
  const { year, subject, task, given, due } = req.body || {};
  const info = await run("INSERT INTO homework (user_id, year, subject, task, given, due) VALUES (?,?,?,?,?,?)",
    [user.id, year, subject || "", task || "", given || "", due || ""]);
  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/homework/:id", async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const rows = await q("SELECT * FROM homework WHERE id = ? AND user_id = ?", [req.params.id, user.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  await run("UPDATE homework SET subject=?, task=?, given=?, due=?, done=? WHERE id=?",
    [b.subject ?? row.subject, b.task ?? row.task, b.given ?? row.given, b.due ?? row.due,
     ("done" in b ? (b.done ? 1 : 0) : row.done), row.id]);
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
  if (user.role !== "owner") return res.status(403).json({ error: "Only the creator can see members." });
  const users = await q("SELECT id, username, role, avatar FROM users ORDER BY id");
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

app.listen(PORT, () => console.log(`✅ Homework Tracker running at http://localhost:${PORT}`));
