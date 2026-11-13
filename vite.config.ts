import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ngspice (eecircuit-engine, ~20 MB with the wasm inlined) is only ever imported
// from src/sim/worker.ts, so it lands in its own lazily-fetched worker chunk and
// the editor paints before the engine has downloaded.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 25000 },
  test: { environment: 'node', testTimeout: 60000 },
});
