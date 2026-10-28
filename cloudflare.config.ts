import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "planet-forge",
    "domains": ["planet-forge.ioupg.com"],
    "compatibilityDate": "2026-10-23",
    "observability": {
      "enabled": true
    },
    "assets": {
      "notFoundHandling": "single-page-application"
    }
  }
});
