import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLOR_ROLES,
  DEFAULT_COLOR_SCHEMES,
  SHAPE_TOKENS,
  SPACING_TOKENS,
  TYPOGRAPHY_TOKENS,
  contrastRatio,
  resolveColorScheme,
  resolveOnColor,
  resolveShape,
  resolveSpacing,
  resolveTypography,
} from "../src/spec/design-tokens.js";
import { DEFAULT_WIDGET_PALETTES } from "../src/spec/component-catalog.js";

test("light and dark schemes provide every semantic color role", () => {
  for (const mode of ["light", "dark"] as const) {
    const scheme = resolveColorScheme(mode);
    assert.deepEqual(Object.keys(scheme).sort(), [...COLOR_ROLES].sort());
    assert.deepEqual(scheme, DEFAULT_COLOR_SCHEMES[mode]);
  }
});

test("custom seed colors resolve deterministic semantic palettes for both modes", () => {
  const light = resolveColorScheme("light", { seedColor: "#008577" });
  const dark = resolveColorScheme("dark", { seedColor: "#008577" });
  assert.equal(light.primary, "#008577");
  assert.equal(dark.primary, "#008577");
  assert.notEqual(light.primaryContainer, dark.primaryContainer);
  assert.notEqual(light.secondary, light.tertiary);
  assert.deepEqual(light, resolveColorScheme("light", { seedColor: "#008577" }));
});

test("legacy palette values map to semantic roles while missing roles use deterministic defaults", () => {
  const scheme = resolveColorScheme("light", { legacyPalette: DEFAULT_WIDGET_PALETTES.light });
  assert.equal(scheme.background, DEFAULT_WIDGET_PALETTES.light.background);
  assert.equal(scheme.surface, DEFAULT_WIDGET_PALETTES.light.surface);
  assert.equal(scheme.onSurface, DEFAULT_WIDGET_PALETTES.light.text);
  assert.equal(scheme.onSurfaceVariant, DEFAULT_WIDGET_PALETTES.light.muted);
  assert.equal(scheme.primary, DEFAULT_WIDGET_PALETTES.light.accent);
  assert.equal(scheme.outline, DEFAULT_WIDGET_PALETTES.light.border);
  assert.equal(scheme.error, DEFAULT_COLOR_SCHEMES.light.error);
});

test("on-colors select the higher-contrast neutral and contrast is safe on invalid input", () => {
  const foreground = resolveOnColor("#6750A4");
  assert.ok((contrastRatio(foreground, "#6750A4") ?? 0) >= 4.5);
  assert.equal(contrastRatio("invalid", "#FFFFFF"), null);
});

test("typography tokens support compact numeral hierarchy and line-height bounds", () => {
  assert.equal(resolveTypography("numeral").tabularNumbers, true);
  assert.equal(resolveTypography("numeral", true).fontSizeDp, 24);
  for (const token of Object.values(TYPOGRAPHY_TOKENS)) {
    assert.ok(token.fontSizeDp >= 10 && token.fontSizeDp <= 32);
    assert.ok(token.lineHeightDp >= token.fontSizeDp);
  }
});

test("shape and spacing resolvers return only defined tokens", () => {
  for (const [role, size] of Object.entries(SHAPE_TOKENS)) assert.equal(resolveShape(role as keyof typeof SHAPE_TOKENS), size);
  for (const [role, size] of Object.entries(SPACING_TOKENS)) assert.equal(resolveSpacing(role as keyof typeof SPACING_TOKENS), size);
});
