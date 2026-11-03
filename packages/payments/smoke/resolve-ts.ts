import { registerHooks } from 'node:module';

// Lets plain `node` run the spike from source. Node strips TypeScript types itself, but sources import
// './x.js' (NodeNext style) where only './x.ts' exists. This retries such relative imports with .ts.
// Dev scripts only; no extra dependency (tsx pulls in esbuild, which our pnpm build policy blocks).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
