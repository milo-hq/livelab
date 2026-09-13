import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, host_id TEXT NOT NULL, host_name TEXT NOT NULL,
     mode TEXT NOT NULL, stream_path TEXT NOT NULL, stream_key TEXT NOT NULL, cover_url TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, coins INTEGER NOT NULL, price_cents INTEGER NOT NULL,
     status TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER)`,
  // Idempotency table for payment-provider webhooks: one row per provider event id.
  `CREATE TABLE IF NOT EXISTS payment_events (
     event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL)`,
  // Double-entry ledger: every money movement is a pair of rows that sum to zero.
  `CREATE TABLE IF NOT EXISTS ledger_entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL, account TEXT NOT NULL,
     delta INTEGER NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ledger_tx ON ledger_entries(tx_id)`,
  // Idempotency for gift sends: (user, idempotency key) unique.
  `CREATE TABLE IF NOT EXISTS gift_orders (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL, gift_id TEXT NOT NULL,
     count INTEGER NOT NULL, amount INTEGER NOT NULL, idem_key TEXT NOT NULL, msg_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, UNIQUE(user_id, idem_key))`,
  `CREATE TABLE IF NOT EXISTS mod_state (room_id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
];

export function openDb(path = ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
