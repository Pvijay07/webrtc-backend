// ============================================
// MINIMAL TEST SERVER - temporary debug deploy
// ============================================
const http = require("http");

const PORT = process.env.PORT || 3000;

console.log(`[DEBUG] process.env.PORT = ${process.env.PORT}`);
console.log(`[DEBUG] Will listen on port: ${PORT}`);
console.log(`[DEBUG] Node version: ${process.version}`);

const server = http.createServer((req, res) => {
  console.log(`[DEBUG] Incoming request: ${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", port: PORT, url: req.url }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[DEBUG] HTTP server is LIVE on 0.0.0.0:${PORT}`);
});

server.on("error", (err) => {
  console.error(`[DEBUG] Server error:`, err);
});
