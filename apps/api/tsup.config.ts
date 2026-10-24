import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Bundle the workspace package (TypeScript source); keep real npm deps external.
  noExternal: ['@familyhub/shared'],
});
