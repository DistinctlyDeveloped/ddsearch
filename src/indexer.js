#!/usr/bin/env node
import db from './db.js';
import { getCollections } from './collections.js';
import { chunkFile } from './chunker.js';
import { hashContent, isProbablyBinary } from './utils.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import fg from 'fast-glob';

/**
 * Discover files in a collection
 */
function discoverFiles(collection) {
  const pattern = join(collection.base_path, collection.glob_mask);
  const files = fg.sync(pattern, {
    absolute: true,
    onlyFiles: true,
    dot: false
  });
  return files;
}

/**
 * Read file safely as UTF-8, skipping binary files
 */
function readFileSafe(filePath) {
  const buffer = readFileSync(filePath);
  if (isProbablyBinary(buffer)) {
    return { content: null, binary: true };
  }
  return { content: buffer.toString('utf-8'), binary: false };
}

/**
 * Index a single file
 */
function indexFile(collectionId, filePath, forceReindex = false) {
  if (!existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
    return { indexed: false, reason: 'not_found' };
  }

  // Check if file already indexed
  const existing = db.prepare(`
    SELECT id, file_hash FROM file_metadata 
    WHERE collection_id = ? AND file_path = ?
  `).get(collectionId, filePath);

  let content;
  try {
    const result = readFileSafe(filePath);
    if (result.binary) {
      if (existing) {
        db.prepare('DELETE FROM file_metadata WHERE id = ?').run(existing.id);
      }
      console.warn(`Skipping binary file: ${filePath}`);
      return { indexed: false, reason: 'binary' };
    }
    content = result.content;
  } catch (error) {
    console.warn(`Failed to read file: ${filePath} (${error.message})`);
    return { indexed: false, reason: 'read_error' };
  }

  const contentHash = hashContent(content);

  if (existing && existing.file_hash === contentHash && !forceReindex) {
    return { indexed: false, reason: 'unchanged' };
  }

  // If file exists but hash changed, delete old data
  if (existing) {
    db.prepare('DELETE FROM file_metadata WHERE id = ?').run(existing.id);
  }

  // Insert new file metadata
  const fileMetadata = db.prepare(`
    INSERT INTO file_metadata (collection_id, file_path, file_hash)
    VALUES (?, ?, ?)
  `).run(collectionId, filePath, contentHash);

  const fileMetadataId = fileMetadata.lastInsertRowid;

  // Chunk the file
  const chunks = chunkFile(filePath, content);

  // Insert chunks
  const insertChunk = db.prepare(`
    INSERT INTO chunks (file_metadata_id, chunk_index, chunk_text, start_line, end_line, token_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let insertedChunks = 0;
  for (const chunk of chunks) {
    insertChunk.run(
      fileMetadataId,
      chunk.chunkIndex,
      chunk.text,
      chunk.startLine,
      chunk.endLine,
      chunk.tokenCount
    );
    insertedChunks++;
  }

  return { indexed: true, chunks: insertedChunks };
}

/**
 * Index all collections (incremental by default)
 */
export function indexCollections(options = {}) {
  const { collectionName = null, full = false } = options;
  const collections = getCollections(collectionName);

  if (collections.length === 0) {
    return { error: 'No collections found' };
  }

  const results = {
    collections: [],
    totalFiles: 0,
    totalChunks: 0,
    indexed: 0,
    skipped: 0,
    removed: 0
  };

  for (const collection of collections) {
    const files = discoverFiles(collection);
    const fileSet = new Set(files);
    let collectionIndexed = 0;
    let collectionSkipped = 0;
    let collectionChunks = 0;
    let collectionRemoved = 0;

    const tx = db.transaction(() => {
      // Remove deleted files from the index
      const existingFiles = db.prepare(`
        SELECT id, file_path FROM file_metadata WHERE collection_id = ?
      `).all(collection.id);

      for (const existing of existingFiles) {
        if (!fileSet.has(existing.file_path)) {
          db.prepare('DELETE FROM file_metadata WHERE id = ?').run(existing.id);
          collectionRemoved++;
        }
      }

      for (const file of files) {
        const result = indexFile(collection.id, file, full);
        if (result.indexed) {
          collectionIndexed++;
          collectionChunks += result.chunks || 0;
        } else {
          collectionSkipped++;
        }
      }
    });

    tx();

    results.collections.push({
      name: collection.name,
      files: files.length,
      indexed: collectionIndexed,
      skipped: collectionSkipped,
      removed: collectionRemoved,
      chunks: collectionChunks
    });

    results.totalFiles += files.length;
    results.indexed += collectionIndexed;
    results.skipped += collectionSkipped;
    results.removed += collectionRemoved;
    results.totalChunks += collectionChunks;
  }

  return results;
}

/**
 * Get chunks that don't have embeddings yet
 */
export function getUnembbeddedChunks(limit = 1000) {
  return db.prepare(`
    SELECT c.id, c.chunk_text
    FROM chunks c
    LEFT JOIN embeddings e ON e.chunk_id = c.id
    WHERE e.chunk_id IS NULL
    LIMIT ?
  `).all(limit);
}

/**
 * Store embeddings for chunks
 */
export function storeEmbeddings(chunkEmbeddings) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO embeddings (chunk_id, embedding, embedding_model)
    VALUES (?, ?, ?)
  `);

  const insert = db.transaction((embeddings) => {
    for (const { chunkId, embedding, model } of embeddings) {
      stmt.run(chunkId, embedding, model);
    }
  });

  insert(chunkEmbeddings);
}
