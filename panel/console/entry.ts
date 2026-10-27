import { createServer } from "./index.ts";

if (!process.env["HERDR_WEB_TOKEN"] || process.getuid?.() !== 1000) throw new Error("Console requires UID 1000 and a bridge credential");
const instance = createServer({
  hostname: "0.0.0.0", port: 7317,
  token: process.env["HERDR_WEB_TOKEN"],
  stateDir: process.env["HERDR_WEB_STATE_DIR"],
  tailscaleOwner: null, machines: false,
});
process.on("SIGTERM", () => { instance.stop(); process.exit(0); });
process.on("SIGINT", () => { instance.stop(); process.exit(0); });
