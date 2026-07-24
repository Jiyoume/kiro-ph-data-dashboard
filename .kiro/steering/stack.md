# Tech Stack

## Overview
Document the technology stack used in this project so Kiro can make informed, consistent decisions when generating or modifying code.

## Frontend
- **Framework**: Vanilla JS (no framework)
- **Language**: JavaScript (ES Modules)
- **Styling**: Plain CSS (inline in index.html, dark theme)
- **Charts**: Chart.js v4
- **State Management**: None (procedural, query-driven)

## Backend
- None — fully client-side, in-browser app

## Database
- **Primary DB**: DuckDB WASM (`@duckdb/duckdb-wasm`) — runs entirely in the browser via WebAssembly
- **Query style**: Raw SQL via DuckDB's async connection API
- **Native addon**: `duckdb` npm package also installed (for potential Node.js server-side use)

## Infrastructure & Deployment
- **Cloud Provider**: None configured yet
- **Containerization**: None
- **CI/CD**: None

## Testing
- None configured yet

## Package Manager & Tooling
- **Package Manager**: npm
- **Build Tool**: Vite (with COOP/COEP headers for SharedArrayBuffer / DuckDB WASM threading)
- **Linter / Formatter**: None configured yet

## Conventions
- Entry point: `index.html` → `src/main.js`
- DuckDB WASM is excluded from Vite pre-bundling (`optimizeDeps.exclude`)
- COOP/COEP headers are required in both `server` and `preview` Vite configs for DuckDB WASM to work
- All SQL queries run through `conn.query()` returning Arrow tables, converted via `.toArray().map(row => Object.fromEntries(row))`
