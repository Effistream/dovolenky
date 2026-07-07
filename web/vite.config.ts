import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only proxy: the Vite dev server (port 5173) forwards /api to the Hono
// server (port 4141), so `npm run web` (API) and `npm run web:dev` (this) run
// side by side with no CORS. In production the Hono server serves web/dist
// directly, so no proxy is needed there.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:4141',
    },
  },
});
