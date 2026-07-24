import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Exclude DuckDB WASM from Vite's pre-bundling — it manages its own worker
    exclude: ['@duckdb/duckdb-wasm'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    watch: {
      // Ignore binary output files so Vite doesn't try to watch/lock parquet writes
      ignored: ['**/*.parquet', '**/*.parquet.tmp'],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
