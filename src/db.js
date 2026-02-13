#!/usr/bin/env node
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, renameSync } from 'fs';

const DB_DIR = join(homedir(), '.ddsearch');
const DB_PATH = join(DB_DIR, 'ddsearch.db');

// Ensure DB directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

function openDatabase() {
  try {
    return new Database(DB_PATH);
  } catch (error) {
    if (error.message.includes('database disk image is malformed')) {
      const corruptPath = `${DB_PATH}.corrupt-${Date.now()}`;
      renameSync(DB_PATH, corruptPath);
      console.warn(`⚠️  Database corruption detected. Backed up to ${corruptPath}. Recreating a fresh database.`);
      return new Database(DB_PATH);
    }
    throw error;
  }
}

function recoverDatabase(currentDb) {
  const corruptPath = `${DB_PATH}.corrupt-${Date.now()}`;
  try {
    currentDb.close();
  } catch (error) {
    // ignore
  }
  renameSync(DB_PATH, corruptPath);
  console.warn(`⚠️  Database corruption detected. Backed up to ${corruptPath}. Recreating a fresh database.`);
  return new Database(DB_PATH);
}

function verifyIntegrity(currentDb) {
  try {
    const result = currentDb.pragma('quick_check');
    if (Array.isArray(result) && result[0]?.quick_check !== 'ok') {
      return recoverDatabase(currentDb);
    }
  } catch (error) {
    if (error.message.includes('database disk image is malformed')) {
      return recoverDatabase(currentDb);
    }
    throw error;
  }
  return currentDb;
}

// Initialize database with WAL mode
export let db = openDatabase();

db = verifyIntegrity(db);

// CRITICAL: Enable WAL mode to avoid blocking the event loop
const walMode = db.pragma('journal_mode = WAL');
if (Array.isArray(walMode) && walMode[0]?.journal_mode !== 'wal') {
  console.warn(`⚠️  Failed to enable WAL mode (current: ${walMode[0]?.journal_mode})`);
}

db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('busy_timeout = 5000');

// Initialize schema
export function initSchema() {
  db.exec(`
    -- Collections table
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      base_path TEXT NOT NULL,
      glob_mask TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- File metadata table (for incremental indexing)
    CREATE TABLE IF NOT EXISTS file_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      UNIQUE(collection_id, file_path)
    );

    -- Chunks table (stores chunk text and metadata)
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_metadata_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      FOREIGN KEY (file_metadata_id) REFERENCES file_metadata(id) ON DELETE CASCADE
    );

    -- FTS5 virtual table for BM25 keyword search
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_text,
      content=chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS5 in sync
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    -- Embeddings table (stores vector embeddings as BLOBs)
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_file_metadata_collection ON file_metadata(collection_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_metadata ON chunks(file_metadata_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embeddings(chunk_id);
  `);
}

// Initialize on import
initSchema();

export default db;
