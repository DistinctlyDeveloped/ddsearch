# ddsearch

Local-first markdown search CLI + HTTP sidecar combining BM25 full-text search + vector semantic search + hybrid reranking.

## Features

- **BM25 full-text search** — Fast keyword search using SQLite FTS5
- **Vector semantic search** — Meaning-based search using OpenAI embeddings
- **Hybrid search** — Combines both for best results
- **Incremental indexing** — Only re-indexes changed files
- **Collections** — Organize and scope searches by project/directory
- **HTTP API** — Integrate with agents and tools
- **WAL mode** — Non-blocking database access using better-sqlite3

## Installation

```bash
cd ~/projects/ddsearch
npm install
npm link  # Makes 'ddsearch' globally available
```

## Quick Start

```bash
# Add a collection
ddsearch collection add ~/projects/notes --name notes --mask "**/*.md"

# Index the collection
ddsearch index

# Generate embeddings
ddsearch embed

# Search
ddsearch search "how to do X"
ddsearch search "semantic query" --mode vector
ddsearch search "keyword search" --mode bm25
```

## CLI Commands

### Collection Management

```bash
# Add a collection
ddsearch collection add <path> --name <name> [--mask <glob>]

# List collections
ddsearch collection list

# Remove a collection
ddsearch collection remove <name>
```

### Indexing

```bash
# Incremental index (only changed files)
ddsearch index

# Force full re-index
ddsearch index --full

# Index specific collection
ddsearch index --collection <name>
```

### Embedding

```bash
# Generate embeddings for all chunks
ddsearch embed

# Custom batch size
ddsearch embed --batch-size 50
```

### Search

```bash
# Hybrid search (default: 40% BM25 + 60% vector)
ddsearch search "query"

# BM25 only
ddsearch search "query" --mode bm25

# Vector only
ddsearch search "query" --mode vector

# Limit results
ddsearch search "query" --limit 20

# Filter by collection
ddsearch search "query" --collection notes

# Minimum score threshold
ddsearch search "query" --min-score 0.5

# JSON output
ddsearch search "query" --json

# Show unique files only
ddsearch search "query" --files
```

### Utilities

```bash
# Get file content
ddsearch get path/to/file.md

# Show statistics
ddsearch stats
```

### HTTP Server

```bash
# Start server (default port 3077)
ddsearch serve

# Custom port
ddsearch serve --port 8080
```

## HTTP API

### POST /search

Search indexed content.

```json
{
  "query": "search term",
  "mode": "hybrid",
  "limit": 10,
  "minScore": 0.3,
  "collection": "notes"
}
```

### GET /stats

Get index statistics.

### GET /health

Health check.

### GET /file?path=/path/to/file.md

Retrieve file content.

## Configuration

### OpenAI API Key

Set via environment variable or file:

```bash
export OPENAI_API_KEY=sk-...
# OR
echo "sk-..." > ~/.openclaw/secrets/openai-api-key.txt
```

### Database Location

Default: `~/.ddsearch/ddsearch.db`

## Architecture

- **better-sqlite3** — WAL mode for non-blocking access
- **FTS5** — BM25 scoring for keyword search
- **Vector embeddings** — Stored as BLOBs, cosine similarity for semantic search
- **Incremental indexing** — SHA256 hashing to detect file changes
- **Content-based chunking** — ~300 tokens per chunk, respects markdown structure

## Example: Multi-Agent Setup

```bash
# Index different agent workspaces
ddsearch collection add ~/projects/stylemcp --name stylemcp --mask "**/*.md"
ddsearch collection add ~/openclaw/main --name openclaw --mask "**/*.md"
ddsearch collection add ~/docs --name docs --mask "**/*.md"

# Index all
ddsearch index && ddsearch embed

# Search across all collections
ddsearch search "authentication flow"

# Search specific collection
ddsearch search "style guide" --collection stylemcp
```

## Performance

- BM25 search: ~1-10ms for typical queries
- Vector search: ~100-500ms depending on corpus size
- Embedding generation: ~100 chunks per API call, batched automatically
- Incremental indexing: Only processes changed files

## License

MIT
