import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const userDataDir = resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? ".local/chatgpt-image-profile");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/google-chrome";
await mkdir(userDataDir, { recursive: true });
console.log(`Opening ordinary Chrome with the dedicated profile: ${userDataDir}`);
console.log("Sign in to ChatGPT, then close the Chrome window. Google sign-in is intentionally not automated.");

const chrome = spawn(executablePath, [
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-mode",
  "https://chatgpt.com/",
], { stdio: "inherit" });

await new Promise<void>((resolveExit, reject) => {
  chrome.once("error", reject);
  chrome.once("close", (code) => {
    if (code === 0) resolveExit();
    else reject(new Error(`Chrome exited with status ${code ?? "unknown"}.`));
  });
});
console.log("Dedicated ChatGPT profile saved. Start or restart the WidgetComposer API.");
