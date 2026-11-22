import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT musí byť platné číslo portu");
}

const address = `http://127.0.0.1:${port}`;
let response;
try {
  response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1500) });
} catch {
  // No server is listening yet.
}

if (response) {
  const health = await response.json().catch(() => ({}));
  if (!response.ok || health.service !== "Nexus LITE Ingest & Gallery") {
    throw new Error(`Port ${port} už používa iná aplikácia`);
  }
  console.log(`Nexus LITE už beží: ${address}`);
} else {
  const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
  const python = process.env.PYTHON || (existsSync(venvPython) ? venvPython : "python");
  const child = spawn(python, ["run_lite.py"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NO_BROWSER: "1", PYTHONIOENCODING: "utf-8" },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`Nexus LITE sa nepodarilo spustiť: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => { process.exitCode = code || 0; });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}
