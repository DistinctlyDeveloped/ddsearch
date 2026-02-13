#!/usr/bin/env node
import db from './db.js';
import { resolve, sep } from 'path';
import { existsSync, statSync, realpathSync } from 'fs';

/**
 * Add a new collection
 */
export function addCollection(name, basePath, globMask = '**/*.md') {
  const absolutePath = resolve(basePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Base path does not exist: ${absolutePath}`);
  }

  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`Base path is not a directory: ${absolutePath}`);
  }

  const stmt = db.prepare(`
    INSERT INTO collections (name, base_path, glob_mask)
    VALUES (?, ?, ?)
  `);

  try {
    stmt.run(name, absolutePath, globMask);
    return { name, basePath: absolutePath, globMask };
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      throw new Error(`Collection "${name}" already exists`);
    }
    throw error;
  }
}

/**
 * Remove a collection and all its indexed data
 */
export function removeCollection(name) {
  const collection = db.prepare('SELECT id FROM collections WHERE name = ?').get(name);

  if (!collection) {
    throw new Error(`Collection "${name}" not found`);
  }

  // Delete cascade will handle file_metadata, chunks, and embeddings
  db.prepare('DELETE FROM collections WHERE id = ?').run(collection.id);

  return { name, deleted: true };
}

/**
 * List all collections
 */
export function listCollections() {
  return db.prepare(`
    SELECT 
      c.id,
      c.name,
      c.base_path,
      c.glob_mask,
      c.created_at,
      COUNT(DISTINCT fm.id) as file_count,
      COUNT(ch.id) as chunk_count,
      COUNT(e.chunk_id) as embedded_count
    FROM collections c
    LEFT JOIN file_metadata fm ON fm.collection_id = c.id
    LEFT JOIN chunks ch ON ch.file_metadata_id = fm.id
    LEFT JOIN embeddings e ON e.chunk_id = ch.id
    GROUP BY c.id
    ORDER BY c.name
  `).all();
}

/**
 * Get a collection by name
 */
export function getCollection(name) {
  return db.prepare('SELECT * FROM collections WHERE name = ?').get(name);
}

/**
 * Get all collections or filter by name
 */
export function getCollections(nameFilter = null) {
  if (nameFilter) {
    const collection = getCollection(nameFilter);
    return collection ? [collection] : [];
  }
  return db.prepare('SELECT * FROM collections ORDER BY name').all();
}

/**
 * Resolve a file path and ensure it belongs to a collection
 */
export function resolveFileInCollections(filePath) {
  const collections = getCollections();
  if (collections.length === 0) return null;

  if (!existsSync(filePath)) return null;

  const resolvedFile = realpathSync(filePath);

  for (const collection of collections) {
    const basePath = realpathSync(collection.base_path);
    if (resolvedFile === basePath || resolvedFile.startsWith(basePath + sep)) {
      return { collection, resolvedPath: resolvedFile };
    }
  }

  return null;
}
