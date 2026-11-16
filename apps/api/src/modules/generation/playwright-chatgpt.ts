import { chromium, type Locator } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { HttpError } from "../../lib/errors.js";
import { devLog } from "../../lib/logger.js";
import { type GeneratedImage, type ImageGenerator } from "./image-generator.js";

const MAX_IMAGE_BYTES = 4_000_000;
const CHATGPT_URL = "https://chatgpt.com/";

/**
 * Optional UI-backed image provider. It uses a dedicated persistent Chrome profile
 * which the operator signs into once; API clients never submit or receive credentials.
 */
export function playwrightChatGptImageGenerator(options: {
  userDataDir: string;
  executablePath?: string;
  maxImagesPerHour: number;
}): ImageGenerator {
  let queue = Promise.resolve();
  const generations: number[] = [];
  return (prompt) => {
    const task = queue.then(() => {
      const cutoff = Date.now() - 60 * 60_000;
      while (generations[0] !== undefined && generations[0] <= cutoff) generations.shift();
      if (generations.length >= options.maxImagesPerHour) {
        throw new HttpError(429, "IMAGE_RATE_LIMITED", "The shared Playwright image limit has been reached. Try again later.");
      }
      generations.push(Date.now());
      return generateFromChatGpt(prompt, options);
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  };
}

async function generateFromChatGpt(
  prompt: string,
  options: { userDataDir: string; executablePath?: string },
): Promise<GeneratedImage> {
  const generationStarted = Date.now();
  devLog("image.playwright", "starting ChatGPT image generation", {
    promptCharacters: prompt.length,
    profileConfigured: Boolean(options.userDataDir),
  });
  const downloadDir = await mkdtemp(join(tmpdir(), "widgetcomposer-image-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(resolve(options.userDataDir), {
      // Keep the signed-in browser visible so the operator can handle any
      // interactive challenge or consent screen before generation continues.
      headless: false,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      acceptDownloads: true,
      downloadsPath: downloadDir,
      timeout: 30_000,
    });
  } catch (error) {
    devLog("image.playwright", "Chrome profile launch failed", {
      error: error instanceof Error ? error.message : String(error),
      executableConfigured: Boolean(options.executablePath),
    });
    await rm(downloadDir, { recursive: true, force: true });
    throw new HttpError(503, "IMAGE_BROWSER_UNAVAILABLE", "The Playwright Chrome profile could not start. Close the image-login browser and check the configured Chrome path.");
  }

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.waitForTimeout(2_000);
    devLog("image.playwright", "ChatGPT page loaded", { url: safePageUrl(page.url()), title: await page.title().catch(() => "") });
    if (await needsLogin(page)) {
      devLog("image.playwright", "sign-in required; waiting for manual sign-in in the visible Chrome window", { timeoutMs: 120_000 });
      const signedIn = await waitForSignedInChatGpt(page, 120_000);
      if (!signedIn) throw loginRequiredError();
      devLog("image.playwright", "ChatGPT sign-in detected", { url: safePageUrl(page.url()) });
    }

    devLog("image.playwright", "waiting for visible prompt box", { timeoutMs: 120_000 });
    const composer = await findComposer(page, 120_000);
    if (!composer) {
      const diagnostic = await composerDiagnostics(page);
      devLog("image.playwright", "composer not found", diagnostic);
      throw new HttpError(
        502,
        "IMAGE_BROWSER_UI_CHANGED",
        `Playwright could not find the ChatGPT prompt box (page: ${diagnostic.title || "untitled"}; ${diagnostic.editableCount} visible editable field(s)). The page may be signed out, still loading, or its interface may have changed. Check backend dev logs for field details.`,
      );
    }
    devLog("image.playwright", "composer found", { selector: await describeLocator(composer), url: safePageUrl(page.url()) });
    const request = `Generate one original widget illustration. Image brief: ${prompt}. Return an image, not a written description.`;
    await composer.fill(request);
    await composer.press("Enter");
    devLog("image.playwright", "image prompt submitted", { promptCharacters: request.length });

    const lastAssistant = page.locator('[data-message-author-role="assistant"]').last();
    try {
      await lastAssistant.locator("img").last().waitFor({ state: "visible", timeout: 110_000 });
      await lastAssistant.locator("img").last().click();
      devLog("image.playwright", "generated image became visible", { elapsedMs: Date.now() - generationStarted });
    } catch {
      if (await needsLogin(page)) throw loginRequiredError();
      throw new HttpError(502, "IMAGE_BROWSER_GENERATION_FAILED", "ChatGPT did not produce a visible image. Check the signed-in account and retry.");
    }
    const downloadButton = page.getByRole("button", { name: /download/i }).last();
    try {
      await downloadButton.waitFor({ state: "visible", timeout: 110_000 });
    } catch {
      throw new HttpError(502, "IMAGE_BROWSER_GENERATION_FAILED", "ChatGPT did not expose a downloadable generated image. Check the signed-in account and retry.");
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    const filePath = join(downloadDir, basename(download.suggestedFilename() || "widget-image.png"));
    await download.saveAs(filePath);
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new HttpError(502, "IMAGE_TOO_LARGE", "The generated image is larger than the widget image limit.");
    }
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new HttpError(502, "IMAGE_FORMAT_UNSUPPORTED", "The downloaded image format is not supported by widgets.");
    devLog("image.playwright", "image downloaded", { mediaType, bytes: bytes.length, elapsedMs: Date.now() - generationStarted });
    return { mediaType, base64: bytes.toString("base64") };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    devLog("image.playwright", "image generation failed", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - generationStarted,
    });
    throw new HttpError(502, "IMAGE_BROWSER_GENERATION_FAILED", "Playwright could not generate and download the image from ChatGPT. Retry or use the OpenAI Images API provider.");
  } finally {
    await context.close().catch(() => undefined);
    await rm(downloadDir, { recursive: true, force: true });
  }
}

function loginRequiredError(): HttpError {
  return new HttpError(503, "IMAGE_BROWSER_LOGIN_REQUIRED", "Sign in to ChatGPT with the dedicated Playwright profile: run `npm run image:login` from apps/api, then retry.");
}

async function needsLogin(page: import("playwright-core").Page): Promise<boolean> {
  if (/\/auth\/|\/login|\/log-in/i.test(new URL(page.url()).pathname)) return true;
  return page.getByRole("button", { name: /^(log in|sign in)$/i }).first().isVisible().catch(() => false);
}

async function waitForSignedInChatGpt(page: import("playwright-core").Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = new URL(page.url()).hostname;
    if ((host === "chatgpt.com" || host.endsWith(".chatgpt.com")) && !(await needsLogin(page))) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

async function findComposer(page: import("playwright-core").Page, timeoutMs = 15_000): Promise<Locator | null> {
  const selector = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder]',
    'textarea[aria-label]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="true"][aria-label]',
    '[contenteditable="true"]',
    'textarea',
    '[role="textbox"]',
  ].join(", ");
  const candidates = page.locator(selector);
  // ChatGPT has moved between textarea and contenteditable implementations. Scan
  // visible, enabled candidates rather than relying on one generated class name.
  const deadline = Date.now() + timeoutMs;
  do {
    const count = await candidates.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!(await candidate.isEditable().catch(() => false))) continue;
      return candidate;
    }
    if (Date.now() < deadline) await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

async function composerDiagnostics(page: import("playwright-core").Page) {
  const fields = await page.locator('textarea, input, [contenteditable="true"], [role="textbox"]').evaluateAll((elements) =>
    elements.slice(0, 20).map((element) => {
      const field = element as HTMLElement;
      const style = window.getComputedStyle(field);
      const rect = field.getBoundingClientRect();
      return {
        tag: field.tagName.toLowerCase(),
        id: field.id || undefined,
        role: field.getAttribute("role") || undefined,
        testId: field.getAttribute("data-testid") || undefined,
        placeholder: field.getAttribute("placeholder") || field.getAttribute("data-placeholder") || undefined,
        ariaLabel: field.getAttribute("aria-label") || undefined,
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
        disabled: "disabled" in field ? Boolean((field as HTMLInputElement).disabled) : false,
      };
    }),
  ).catch(() => []);
  return {
    url: safePageUrl(page.url()),
    title: (await page.title().catch(() => "")).slice(0, 160),
    editableCount: fields.filter((field) => field.visible && !field.disabled).length,
    fields,
  };
}

async function describeLocator(locator: Locator): Promise<Record<string, string | undefined>> {
  return locator.evaluate((element) => {
    const field = element as HTMLElement;
    return {
      tag: field.tagName.toLowerCase(),
      id: field.id || undefined,
      testId: field.getAttribute("data-testid") || undefined,
      placeholder: field.getAttribute("placeholder") || field.getAttribute("data-placeholder") || undefined,
      ariaLabel: field.getAttribute("aria-label") || undefined,
    };
  }).catch(() => ({}));
}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function imageMediaType(bytes: Buffer): GeneratedImage["mediaType"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
