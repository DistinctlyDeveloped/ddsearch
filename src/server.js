#!/usr/bin/env node
import express from 'express';
import { search } from './search.js';
import db from './db.js';
import { listCollections, resolveFileInCollections } from './collections.js';
import { readFileSync } from 'fs';

export function createServer(port = 3077, host = '127.0.0.1') {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Stats endpoint
  app.get('/stats', (req, res) => {
    const stats = {
      collections: listCollections(),
      totals: db.prepare(`
        SELECT 
          COUNT(DISTINCT c.id) as total_collections,
          COUNT(DISTINCT fm.id) as total_files,
          COUNT(DISTINCT ch.id) as total_chunks,
          COUNT(DISTINCT e.chunk_id) as total_embeddings
        FROM collections c
        LEFT JOIN file_metadata fm ON fm.collection_id = c.id
        LEFT JOIN chunks ch ON ch.file_metadata_id = fm.id
        LEFT JOIN embeddings e ON e.chunk_id = ch.id
      `).get()
    };

    res.json(stats);
  });

  // Search endpoint
  app.post('/search', async (req, res) => {
    try {
      const {
        query,
        mode = 'hybrid',
        limit = 10,
        minScore = 0,
        collection = null
      } = req.body || {};

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Query is required' });
      }

      if (!['bm25', 'vector', 'hybrid'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode' });
      }

      const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
      const safeMinScore = Math.max(0, Number(minScore) || 0);

      const results = await search(query, {
        mode,
        limit: safeLimit,
        minScore: safeMinScore,
        collectionName: collection
      });

      res.json({
        query,
        mode,
        count: results.length,
        results
      });
    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get file content
  app.get('/file', (req, res) => {
    const { path } = req.query;

    if (!path || typeof path !== 'string') {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    try {
      const resolved = resolveFileInCollections(path);
      if (!resolved) {
        return res.status(403).json({ error: 'File is not within any collection' });
      }

      const content = readFileSync(resolved.resolvedPath, 'utf-8');
      res.json({ path: resolved.resolvedPath, content });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`ddsearch server listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}
