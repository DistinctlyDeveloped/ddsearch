#!/usr/bin/env node
import db from './db.js';
import { cosineSimilarity, bufferToFloat32Array } from './utils.js';
import { generateQueryEmbedding } from './embeddings.js';

function clampLimit(limit, max = 100) {
  const n = Number.isFinite(limit) ? limit : 10;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function escapeFtsQuery(query) {
  const tokens = query
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/"/g, '""'));

  if (tokens.length === 0) return '';

  return tokens.map(t => `"${t}"`).join(' AND ');
}

/**
 * BM25 keyword search using FTS5
 */
export function searchBM25(query, options = {}) {
  const { collectionName = null } = options;
  const limit = clampLimit(options.limit ?? 10);

  const escapedQuery = escapeFtsQuery(query || '');
  if (!escapedQuery) return [];

  let sql = `
    SELECT 
      c.id,
      c.chunk_text,
      c.start_line,
      c.end_line,
      fm.file_path,
      col.name as collection_name,
      bm25(chunks_fts) as score
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.id
    JOIN file_metadata fm ON c.file_metadata_id = fm.id
    JOIN collections col ON fm.collection_id = col.id
    WHERE chunks_fts MATCH ?
  `;

  const params = [escapedQuery];

  if (collectionName) {
    sql += ' AND col.name = ?';
    params.push(collectionName);
  }

  sql += ' ORDER BY bm25(chunks_fts) LIMIT ?';
  params.push(limit);

  let results;
  try {
    results = db.prepare(sql).all(...params);
  } catch (error) {
    if (error.message.includes('fts5')) {
      return [];
    }
    throw error;
  }

  // BM25 scores are negative; convert to positive and normalize
  const scores = results.map(r => Math.abs(r.score));
  const maxScore = Math.max(...scores, 1);

  return results.map((r, i) => ({
    chunkId: r.id,
    text: r.chunk_text,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    collection: r.collection_name,
    score: scores[i] / maxScore,
    rawScore: r.score
  }));
}

/**
 * Vector semantic search using cosine similarity
 */
export async function searchVector(query, options = {}) {
  const { collectionName = null } = options;
  const limit = clampLimit(options.limit ?? 10);

  // If no embeddings exist, return early without calling OpenAI
  let countSql = 'SELECT COUNT(*) as count FROM embeddings e';
  const countParams = [];
  if (collectionName) {
    countSql += ' JOIN chunks c ON e.chunk_id = c.id JOIN file_metadata fm ON c.file_metadata_id = fm.id JOIN collections col ON fm.collection_id = col.id WHERE col.name = ?';
    countParams.push(collectionName);
  }
  const count = db.prepare(countSql).get(...countParams).count;
  if (count === 0) return [];

  // Generate query embedding
  const queryEmbedding = await generateQueryEmbedding(query);

  // Get all embeddings with metadata (streamed)
  let sql = `
    SELECT 
      e.chunk_id,
      e.embedding,
      c.chunk_text,
      c.start_line,
      c.end_line,
      fm.file_path,
      col.name as collection_name
    FROM embeddings e
    JOIN chunks c ON e.chunk_id = c.id
    JOIN file_metadata fm ON c.file_metadata_id = fm.id
    JOIN collections col ON fm.collection_id = col.id
  `;

  const params = [];

  if (collectionName) {
    sql += ' WHERE col.name = ?';
    params.push(collectionName);
  }

  const top = [];

  for (const candidate of db.prepare(sql).iterate(...params)) {
    const embedding = bufferToFloat32Array(candidate.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    const normalized = Math.max(0, Math.min(1, (similarity + 1) / 2));

    const entry = {
      chunkId: candidate.chunk_id,
      text: candidate.chunk_text,
      filePath: candidate.file_path,
      startLine: candidate.start_line,
      endLine: candidate.end_line,
      collection: candidate.collection_name,
      score: normalized,
      rawScore: similarity
    };

    if (top.length < limit) {
      top.push(entry);
    } else {
      // Find current min
      let minIndex = 0;
      for (let i = 1; i < top.length; i++) {
        if (top[i].score < top[minIndex].score) minIndex = i;
      }
      if (entry.score > top[minIndex].score) {
        top[minIndex] = entry;
      }
    }
  }

  top.sort((a, b) => b.score - a.score);
  return top;
}

/**
 * Hybrid search combining BM25 and vector search
 */
export async function searchHybrid(query, options = {}) {
  const { 
    limit = 10, 
    collectionName = null,
    bm25Weight = 0.4,
    vectorWeight = 0.6 
  } = options;

  // Run both searches with higher limit for better fusion
  const bm25Results = searchBM25(query, { limit: limit * 3, collectionName });

  let vectorResults = [];
  try {
    vectorResults = await searchVector(query, { limit: limit * 3, collectionName });
  } catch (error) {
    console.warn(`Vector search unavailable: ${error.message}`);
  }

  // Create a map of chunk scores
  const scoreMap = new Map();

  // Add BM25 scores
  bm25Results.forEach(result => {
    scoreMap.set(result.chunkId, {
      ...result,
      bm25Score: result.score,
      vectorScore: 0
    });
  });

  // Add vector scores
  vectorResults.forEach(result => {
    if (scoreMap.has(result.chunkId)) {
      const existing = scoreMap.get(result.chunkId);
      existing.vectorScore = result.score;
    } else {
      scoreMap.set(result.chunkId, {
        ...result,
        bm25Score: 0,
        vectorScore: result.score
      });
    }
  });

  // Calculate combined scores
  const combined = Array.from(scoreMap.values()).map(result => ({
    ...result,
    score: (result.bm25Score * bm25Weight) + (result.vectorScore * vectorWeight),
    rawScore: { bm25: result.bm25Score, vector: result.vectorScore }
  }));

  // Sort by combined score and limit
  combined.sort((a, b) => b.score - a.score);
  return combined.slice(0, clampLimit(limit));
}

/**
 * Main search dispatcher
 */
export async function search(query, options = {}) {
  const { mode = 'hybrid', minScore = 0 } = options;

  let results;

  switch (mode) {
    case 'bm25':
      results = searchBM25(query, options);
      break;
    case 'vector':
      results = await searchVector(query, options);
      break;
    case 'hybrid':
      results = await searchHybrid(query, options);
      break;
    default:
      throw new Error(`Invalid search mode: ${mode}`);
  }

  // Filter by minimum score
  if (minScore > 0) {
    results = results.filter(r => r.score >= minScore);
  }

  return results;
}

/**
 * Get unique files from search results
 */
export function getUniqueFiles(results) {
  const fileSet = new Set();
  const files = [];

  for (const result of results) {
    if (!fileSet.has(result.filePath)) {
      fileSet.add(result.filePath);
      files.push({
        path: result.filePath,
        collection: result.collection,
        score: result.score
      });
    }
  }

  return files;
}
