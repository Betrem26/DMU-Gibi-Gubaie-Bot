const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbDirectory = path.join(__dirname, "..", "data");
fs.mkdirSync(dbDirectory, { recursive: true });

const dbPath = path.join(dbDirectory, "bot.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.prepare(`
  CREATE TABLE IF NOT EXISTS representatives (
    telegram_user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS department_representatives (
    department_id TEXT NOT NULL,
    representative_user_id INTEGER NOT NULL,
    username TEXT,
    chat_id INTEGER NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (department_id, representative_user_id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_chat_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    department_id TEXT NOT NULL,
    department_name TEXT,
    sub_department_id TEXT,
    sub_department_name TEXT,
    rep_chat_id INTEGER,
    forwarded_message_id INTEGER,
    original_message_id INTEGER,
    message_type TEXT NOT NULL,
    message_text TEXT,
    reply_status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    replied_at TEXT
  )
`).run();

// Migrate: add username and first_name columns if they don't exist yet
const messagesCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
if (!messagesCols.includes("username")) {
  db.prepare("ALTER TABLE messages ADD COLUMN username TEXT").run();
}
if (!messagesCols.includes("first_name")) {
  db.prepare("ALTER TABLE messages ADD COLUMN first_name TEXT").run();
}

function normalizeUsername(value) {
  if (!value) return "";
  return String(value).replace(/^@/, "").trim().toLowerCase();
}

function upsertRepresentative({ telegramUserId, chatId, username, firstName, lastName, isAdmin = false }) {
  if (!telegramUserId || !chatId) return null;

  const normalizedUsername = normalizeUsername(username);

  return db
    .prepare(`
      INSERT INTO representatives (telegram_user_id, chat_id, username, first_name, last_name, is_admin, updated_at)
      VALUES (@telegramUserId, @chatId, @username, @firstName, @lastName, @isAdmin, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        is_admin = excluded.is_admin,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run({
      telegramUserId,
      chatId,
      username: normalizedUsername,
      firstName,
      lastName,
      isAdmin: isAdmin ? 1 : 0,
    });
}

function findRepresentativeByUserId(telegramUserId) {
  return db
    .prepare(`SELECT * FROM representatives WHERE telegram_user_id = ?`)
    .get(telegramUserId);
}

function findRepresentativeByUsername(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  return db
    .prepare(`SELECT * FROM representatives WHERE lower(username) = lower(?) LIMIT 1`)
    .get(normalized);
}

function getRepresentativeByChatId(chatId) {
  return db
    .prepare(`SELECT * FROM representatives WHERE chat_id = ? LIMIT 1`)
    .get(chatId);
}

function isRepresentativeUser(telegramUserId, username) {
  const rep = findRepresentativeByUserId(telegramUserId);
  if (rep) return true;

  const normalized = normalizeUsername(username);
  return Boolean(normalized && findRepresentativeByUsername(normalized));
}

function assignDepartmentRepresentative({ departmentId, representativeUserId, username, chatId }) {
  if (!departmentId || !representativeUserId) return null;

  const normalized = normalizeUsername(username) || normalizeUsername(findRepresentativeByUserId(representativeUserId)?.username);

  return db
    .prepare(`
      INSERT INTO department_representatives (department_id, representative_user_id, username, chat_id)
      VALUES (@departmentId, @representativeUserId, @username, @chatId)
      ON CONFLICT(department_id, representative_user_id) DO UPDATE SET
        username = excluded.username,
        chat_id = excluded.chat_id
    `)
    .run({
      departmentId,
      representativeUserId,
      username: normalized,
      chatId,
    });
}

function getDepartmentRepresentativeChats(departmentId) {
  if (!departmentId) return [];

  const rows = db
    .prepare(`
      SELECT DISTINCT chat_id
      FROM department_representatives
      WHERE department_id = ?
      ORDER BY assigned_at ASC
    `)
    .all(departmentId);

  return rows.map((row) => Number(row.chat_id)).filter((value) => Number.isFinite(value));
}

function getDepartmentRepresentativeUsernames(departmentId) {
  if (!departmentId) return [];

  const rows = db
    .prepare(`
      SELECT DISTINCT username
      FROM department_representatives
      WHERE department_id = ?
      ORDER BY assigned_at ASC
    `)
    .all(departmentId);

  return rows.map((row) => row.username).filter(Boolean);
}

function getRepresentativeChatsByUsernames(usernames) {
  const normalized = Array.from(new Set((Array.isArray(usernames) ? usernames : []).map(normalizeUsername).filter(Boolean)));
  if (!normalized.length) return [];

  const placeholders = normalized.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT DISTINCT chat_id FROM representatives WHERE lower(username) IN (${placeholders})`)
    .all(...normalized);

  return rows.map((row) => Number(row.chat_id)).filter((value) => Number.isFinite(value));
}

function getRegisteredDepartments() {
  return db
    .prepare(`SELECT DISTINCT department_id FROM department_representatives ORDER BY department_id ASC`)
    .all()
    .map((row) => row.department_id);
}

function recordForwardedMessage({
  studentChatId,
  studentUserId,
  username,
  firstName,
  departmentId,
  departmentName,
  subDepartmentId,
  subDepartmentName,
  repChatId,
  forwardedMessageId,
  originalMessageId,
  messageType,
  messageText,
}) {
  return db
    .prepare(`
      INSERT INTO messages (
        student_chat_id,
        student_user_id,
        username,
        first_name,
        department_id,
        department_name,
        sub_department_id,
        sub_department_name,
        rep_chat_id,
        forwarded_message_id,
        original_message_id,
        message_type,
        message_text,
        reply_status
      ) VALUES (
        @studentChatId,
        @studentUserId,
        @username,
        @firstName,
        @departmentId,
        @departmentName,
        @subDepartmentId,
        @subDepartmentName,
        @repChatId,
        @forwardedMessageId,
        @originalMessageId,
        @messageType,
        @messageText,
        'pending'
      )
    `)
    .run({
      studentChatId,
      studentUserId,
      username: username || null,
      firstName: firstName || null,
      departmentId,
      departmentName,
      subDepartmentId,
      subDepartmentName,
      repChatId,
      forwardedMessageId,
      originalMessageId,
      messageType,
      messageText,
    });
}

function getMessageByForwardedMessageId(forwardedMessageId, repChatId) {
  if (!forwardedMessageId) return null;

  return db
    .prepare(`
      SELECT * FROM messages
      WHERE forwarded_message_id = ?
      AND (? IS NULL OR rep_chat_id = ?)
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(forwardedMessageId, repChatId ?? null, repChatId ?? null);
}

function updateReplyStatus({ forwardedMessageId, repChatId, status = "answered", repliedAt = new Date().toISOString() }) {
  if (!forwardedMessageId) return null;

  return db
    .prepare(`
      UPDATE messages
      SET reply_status = @status,
          replied_at = @repliedAt
      WHERE forwarded_message_id = @forwardedMessageId
      AND (@repChatId IS NULL OR rep_chat_id = @repChatId)
    `)
    .run({
      status,
      repliedAt: repliedAt,
      forwardedMessageId,
      repChatId: repChatId ?? null,
    });
}

function getReplyMap() {
  const rows = db
    .prepare(`
      SELECT forwarded_message_id, student_chat_id, rep_chat_id, department_id, department_name, reply_status
      FROM messages
      WHERE forwarded_message_id IS NOT NULL
    `)
    .all();

  const map = new Map();

  for (const row of rows) {
    map.set(Number(row.forwarded_message_id), {
      chatId: Number(row.student_chat_id),
      departmentId: row.department_id,
      departmentName: row.department_name,
      repChatId: Number(row.rep_chat_id),
      replyStatus: row.reply_status,
    });
  }

  return map;
}

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) AS count FROM messages`).get();
  const answered = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE reply_status = 'answered'`).get();
  const pending = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE reply_status = 'pending'`).get();

  const byDepartment = db
    .prepare(`
      SELECT department_id, COUNT(*) AS count
      FROM messages
      GROUP BY department_id
      ORDER BY count DESC
    `)
    .all();

  return {
    total: Number(total.count),
    answered: Number(answered.count),
    pending: Number(pending.count),
    byDepartment,
  };
}

function getPendingMessages() {
  return db.prepare(`
    SELECT m.*, r.username as rep_username
    FROM messages m
    LEFT JOIN department_representatives dr ON dr.department_id = m.department_id AND dr.chat_id = m.rep_chat_id
    LEFT JOIN representatives r ON r.chat_id = m.rep_chat_id
    WHERE m.reply_status = 'pending'
    ORDER BY m.created_at ASC
  `).all();
}

function getPendingMessagesByRepChatId(repChatId) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE reply_status = 'pending' AND rep_chat_id = ?
    ORDER BY created_at ASC
  `).all(repChatId);
}

function getDetailedStats() {
  const total = db.prepare(`SELECT COUNT(*) AS count FROM messages`).get();
  const answered = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE reply_status = 'answered'`).get();
  const pending = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE reply_status = 'pending'`).get();

  const byDepartment = db.prepare(`
    SELECT department_id, department_name,
      COUNT(*) as total,
      SUM(CASE WHEN reply_status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN reply_status='answered' THEN 1 ELSE 0 END) as answered
    FROM messages GROUP BY department_id ORDER BY total DESC
  `).all();

  const topReps = db.prepare(`
    SELECT r.username, COUNT(*) as answered_count
    FROM messages m
    JOIN representatives r ON r.chat_id = m.rep_chat_id
    WHERE m.reply_status = 'answered'
    GROUP BY m.rep_chat_id ORDER BY answered_count DESC LIMIT 5
  `).all();

  return {
    total: Number(total.count),
    pending: Number(pending.count),
    answered: Number(answered.count),
    byDepartment,
    topReps,
  };
}

function getRecentAnsweredMessages(limit = 10) {
  return db.prepare(`
    SELECT m.*, r.username as rep_username
    FROM messages m
    LEFT JOIN representatives r ON r.chat_id = m.rep_chat_id
    WHERE m.reply_status = 'answered'
    ORDER BY m.replied_at DESC
    LIMIT ?
  `).all(limit);
}

function removeDepartmentRepresentative({ departmentId, username }) {
  const normalized = normalizeUsername(username);
  return db
    .prepare(`DELETE FROM department_representatives WHERE department_id = ? AND username = ?`)
    .run(departmentId, normalized);
}

function getUniqueStudentChatIds() {
  const rows = db
    .prepare(`SELECT DISTINCT student_chat_id FROM messages ORDER BY student_chat_id ASC`)
    .all();
  return rows.map((row) => Number(row.student_chat_id)).filter((v) => Number.isFinite(v));
}

function getRepresentativeChatIds() {
  const rows = db.prepare('SELECT DISTINCT chat_id FROM representatives').all();
  return rows.map(r => Number(r.chat_id)).filter(Boolean);
}

function getMessageById(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function updateReplyStatusById({ id, status }) {
  return db.prepare(
    `UPDATE messages SET reply_status = ?, replied_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(status, id);
}

module.exports = {
  db,
  normalizeUsername,
  upsertRepresentative,
  findRepresentativeByUserId,
  findRepresentativeByUsername,
  getRepresentativeByChatId,
  isRepresentativeUser,
  assignDepartmentRepresentative,
  getDepartmentRepresentativeChats,
  getDepartmentRepresentativeUsernames,
  getRepresentativeChatsByUsernames,
  getRegisteredDepartments,
  recordForwardedMessage,
  getMessageByForwardedMessageId,
  updateReplyStatus,
  getReplyMap,
  getStats,
  getPendingMessages,
  getPendingMessagesByRepChatId,
  getDetailedStats,
  getRecentAnsweredMessages,
  removeDepartmentRepresentative,
  getUniqueStudentChatIds,
  getRepresentativeChatIds,
  getMessageById,
  updateReplyStatusById,
};
