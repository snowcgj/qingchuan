import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// A browser-only build for the local Node server; no cloud runtime is required.
export default defineConfig({
  plugins:[react()],
  build:{outDir:'dist-local',emptyOutDir:true},
});
