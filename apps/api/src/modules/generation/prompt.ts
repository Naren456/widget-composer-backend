import { HttpError } from "../../lib/errors.js";

const cleanPrompt = (input: string) =>
  input
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\s\u00A0]+/g, " ")
    .trim();

/** Normalize user input without spending a provider request before generation. */
export function prepareWidgetPrompt(input: string): string {
  const raw = cleanPrompt(input);
  if (raw.length < 5 || raw.length > 500 || !/[\p{L}\p{N}]/u.test(raw)) {
    throw new HttpError(422, "INVALID_PROMPT", "Describe the widget you want, including what information it should show.");
  }
  return raw;
}
