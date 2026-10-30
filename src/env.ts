import { existsSync } from "node:fs";
// Node preserves variables already supplied by the host when loading a local file.
if (existsSync(".env")) process.loadEnvFile(".env");
