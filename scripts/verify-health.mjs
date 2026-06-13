#!/usr/bin/env node
/**
 * Mail Intelligence health verification.
 * Default: syntax-only (no running server required).
 * Full: start server briefly and probe /api/outlook/status.
 *
 * Port: package.json uses PORT=3010 (integration default).
 * Legacy docs may reference 10200 — set PORT explicitly if needed.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv.includes("--full") ? "full" : "syntax";
const port = Number(process.env.PORT || process.env.MAIL_INTELLIGENCE_PORT || 3010);
const host = process.env.MAIL_INTELLIGENCE_HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

function runNodeCheck(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${file}: ${stderr.trim() || "syntax check failed"}`));
    });
  });
}

async function probeStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/api/outlook/status`, {
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function runFullCheck() {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

  const killServer = () => {
    if (!server.killed) server.kill("SIGTERM");
  };

  try {
    await delay(1500);
    const body = await probeStatus();
    console.log(`[verify-health] OK ${baseUrl}/api/outlook/status`, body);
  } catch (error) {
    console.error("[verify-health] API probe failed:", error);
    if (serverLog) console.error(serverLog.trim());
    process.exitCode = 1;
  } finally {
    killServer();
    await delay(300);
  }
}

async function main() {
  await runNodeCheck("server.mjs");
  console.log("[verify-health] server.mjs syntax OK");

  if (mode === "syntax") {
    console.log(
      `[verify-health] syntax-only PASS (use --full to probe ${baseUrl}/api/outlook/status)`,
    );
    return;
  }

  console.log(`[verify-health] full mode: probing ${baseUrl}`);
  await runFullCheck();
}

main().catch((error) => {
  console.error("[verify-health] FAIL:", error.message || error);
  process.exit(1);
});
