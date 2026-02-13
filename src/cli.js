#!/usr/bin/env node
import { Command } from 'commander';
import { addCollection, removeCollection, listCollections, resolveFileInCollections } from './collections.js';
import { indexCollections, getUnembbeddedChunks, storeEmbeddings } from './indexer.js';
import { search, getUniqueFiles } from './search.js';
import { generateEmbeddings } from './embeddings.js';
import { float32ArrayToBuffer } from './utils.js';
import { createServer } from './server.js';
import { readFileSync } from 'fs';
import db from './db.js';

const program = new Command();

program
  .name('ddsearch')
  .description('Local-first markdown search with BM25 + vector semantic search')
  .version('1.0.0');

// Collection management
const collectionCmd = program.command('collection').description('Manage collections');

collectionCmd
  .command('add <path>')
  .description('Add a new collection')
  .requiredOption('-n, --name <name>', 'Collection name')
  .option('-m, --mask <mask>', 'Glob mask for files', '**/*.md')
  .action((path, options) => {
    try {
      const result = addCollection(options.name, path, options.mask);
      console.log(`✓ Collection "${result.name}" added`);
      console.log(`  Path: ${result.basePath}`);
      console.log(`  Mask: ${result.globMask}`);
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

collectionCmd
  .command('remove <name>')
  .description('Remove a collection')
  .action((name) => {
    try {
      removeCollection(name);
      console.log(`✓ Collection "${name}" removed`);
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

collectionCmd
  .command('list')
  .description('List all collections')
  .action(() => {
    const collections = listCollections();

    if (collections.length === 0) {
      console.log('No collections found');
      return;
    }

    console.log('\nCollections:\n');
    for (const col of collections) {
      console.log(`${col.name}`);
      console.log(`  Path: ${col.base_path}`);
      console.log(`  Mask: ${col.glob_mask}`);
      console.log(`  Files: ${col.file_count}, Chunks: ${col.chunk_count}, Embedded: ${col.embedded_count}`);
      console.log('');
    }
  });

// Index command
program
  .command('index')
  .description('Index collections (incremental by default)')
  .option('-f, --full', 'Force full re-index')
  .option('-c, --collection <name>', 'Index specific collection')
  .action((options) => {
    try {
      console.log('Indexing collections...');
      const result = indexCollections({
        collectionName: options.collection,
        full: options.full
      });

      if (result.error) {
        console.error(`✗ ${result.error}`);
        process.exit(1);
      }

      console.log(`\n✓ Indexing complete`);
      console.log(`  Total files: ${result.totalFiles}`);
      console.log(`  Indexed: ${result.indexed}`);
      console.log(`  Skipped (unchanged): ${result.skipped}`);
      console.log(`  Removed (deleted files): ${result.removed}`);
      console.log(`  Total chunks: ${result.totalChunks}\n`);

      for (const col of result.collections) {
        console.log(`  ${col.name}: ${col.indexed} indexed, ${col.skipped} skipped, ${col.removed} removed, ${col.chunks} chunks`);
      }
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Embed command
program
  .command('embed')
  .description('Generate embeddings for indexed chunks')
  .option('-b, --batch-size <size>', 'Batch size for embedding generation', '100')
  .action(async (options) => {
    try {
      const batchSize = parseInt(options.batchSize, 10) || 100;
      let totalEmbedded = 0;

      console.log('Generating embeddings...');

      while (true) {
        const chunks = getUnembbeddedChunks(batchSize);

        if (chunks.length === 0) {
          break;
        }

        console.log(`Processing batch of ${chunks.length} chunks...`);

        const texts = chunks.map(c => c.chunk_text);
        const embeddings = await generateEmbeddings(texts);

        const chunkEmbeddings = chunks.map((chunk, i) => ({
          chunkId: chunk.id,
          embedding: float32ArrayToBuffer(embeddings[i]),
          model: 'text-embedding-3-small'
        }));

        storeEmbeddings(chunkEmbeddings);
        totalEmbedded += chunks.length;

        console.log(`  ${totalEmbedded} embeddings generated`);
      }

      console.log(`\n✓ Embedding complete: ${totalEmbedded} total embeddings`);
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Search command
program
  .command('search <query>')
  .description('Search indexed content')
  .option('-m, --mode <mode>', 'Search mode: bm25, vector, hybrid', 'hybrid')
  .option('-l, --limit <limit>', 'Maximum results', '10')
  .option('-s, --min-score <score>', 'Minimum score threshold', '0')
  .option('-c, --collection <name>', 'Filter by collection')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --files', 'Show unique files only')
  .action(async (query, options) => {
    try {
      if (!['bm25', 'vector', 'hybrid'].includes(options.mode)) {
        throw new Error('Invalid search mode. Use bm25, vector, or hybrid.');
      }

      const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 10));
      const minScore = Math.max(0, parseFloat(options.minScore) || 0);

      const results = await search(query, {
        mode: options.mode,
        limit,
        minScore,
        collectionName: options.collection
      });

      if (options.json) {
        console.log(JSON.stringify({ query, mode: options.mode, count: results.length, results }, null, 2));
        return;
      }

      if (options.files) {
        const files = getUniqueFiles(results);
        console.log(`\nFound ${files.length} matching files:\n`);
        for (const file of files) {
          console.log(`${file.path} (score: ${file.score.toFixed(3)})`);
        }
        return;
      }

      console.log(`\nSearch: "${query}" (mode: ${options.mode})`);
      console.log(`Found ${results.length} results:\n`);

      for (const result of results) {
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Score: ${result.score.toFixed(3)} | ${result.filePath}:${result.startLine}-${result.endLine}`);
        console.log(`Collection: ${result.collection}`);
        console.log('');

        // Show snippet (first 200 chars)
        const snippet = result.text.substring(0, 200).replace(/\n/g, ' ');
        console.log(snippet + (result.text.length > 200 ? '...' : ''));
        console.log('');
      }
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Get file content
program
  .command('get <path>')
  .description('Retrieve full file content (must be inside a collection)')
  .action((path) => {
    try {
      const resolved = resolveFileInCollections(path);
      if (!resolved) {
        console.error('✗ File is not within any collection');
        process.exit(1);
      }

      const content = readFileSync(resolved.resolvedPath, 'utf-8');
      console.log(content);
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Stats command
program
  .command('stats')
  .description('Show index statistics')
  .action(() => {
    const collections = listCollections();

    const totals = db.prepare(`
      SELECT 
        COUNT(DISTINCT fm.id) as total_files,
        COUNT(DISTINCT c.id) as total_chunks,
        COUNT(DISTINCT e.chunk_id) as total_embeddings
      FROM file_metadata fm
      LEFT JOIN chunks c ON c.file_metadata_id = fm.id
      LEFT JOIN embeddings e ON e.chunk_id = c.id
    `).get();

    console.log('\nIndex Statistics:\n');
    console.log(`Collections: ${collections.length}`);
    console.log(`Total files: ${totals.total_files}`);
    console.log(`Total chunks: ${totals.total_chunks}`);
    console.log(`Total embeddings: ${totals.total_embeddings}`);
    console.log('');

    if (collections.length > 0) {
      console.log('By Collection:\n');
      for (const col of collections) {
        console.log(`  ${col.name}: ${col.file_count} files, ${col.chunk_count} chunks, ${col.embedded_count} embedded`);
      }
    }
  });

// Server command
program
  .command('serve')
  .description('Start HTTP server')
  .option('-p, --port <port>', 'Server port', '3077')
  .option('-H, --host <host>', 'Bind host', '127.0.0.1')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10) || 3077;
      await createServer(port, options.host);
      console.log(`Server running. Press Ctrl+C to stop.`);
    } catch (error) {
      console.error(`✗ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
