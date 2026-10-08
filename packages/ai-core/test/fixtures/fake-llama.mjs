#!/usr/bin/env node
// Stand-in for llama-server: answers /health on --port, and takes a second to exit on SIGTERM,
// the way the real one finishes its slots before it goes.
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1000));
