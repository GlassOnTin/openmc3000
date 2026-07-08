import { defineConfig } from "vite";

// base './' keeps asset paths relative so the build works on any host incl. GitHub Pages.
// fs.allow '..' lets the app import the protocol codec from the repo-root src/ (single
// source of truth shared with the Node CLI).
export default defineConfig({
  base: "./",
  server: { fs: { allow: [".."] } },
});
