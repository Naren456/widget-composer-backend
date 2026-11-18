import { type WidgetPalette } from "./component-catalog.js";

export const COLOR_ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "outline",
  "outlineVariant",
  "error",
  "onError",
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];
export type ColorSchemeMode = "light" | "dark";
export type SemanticColorScheme = Readonly<Record<ColorRole, string>>;

export const DEFAULT_COLOR_SCHEMES: Readonly<Record<ColorSchemeMode, SemanticColorScheme>> = {
  light: {
    primary: "#6750A4",
    onPrimary: "#FFFFFF",
    primaryContainer: "#EADDFF",
    onPrimaryContainer: "#21005D",
    secondary: "#625B71",
    onSecondary: "#FFFFFF",
    secondaryContainer: "#E8DEF8",
    onSecondaryContainer: "#1D192B",
    tertiary: "#7D5260",
    onTertiary: "#FFFFFF",
    tertiaryContainer: "#FFD8E4",
    onTertiaryContainer: "#31111D",
    background: "#FEF7FF",
    onBackground: "#1D1B20",
    surface: "#FEF7FF",
    onSurface: "#1D1B20",
    surfaceVariant: "#E7E0EC",
    onSurfaceVariant: "#49454F",
    outline: "#79747E",
    outlineVariant: "#CAC4D0",
    error: "#B3261E",
    onError: "#FFFFFF",
  },
  dark: {
    primary: "#D0BCFF",
    onPrimary: "#381E72",
    primaryContainer: "#4F378B",
    onPrimaryContainer: "#EADDFF",
    secondary: "#CCC2DC",
    onSecondary: "#332D41",
    secondaryContainer: "#4A4458",
    onSecondaryContainer: "#E8DEF8",
    tertiary: "#EFB8C8",
    onTertiary: "#492532",
    tertiaryContainer: "#633B48",
    onTertiaryContainer: "#FFD8E4",
    background: "#141218",
    onBackground: "#E6E0E9",
    surface: "#141218",
    onSurface: "#E6E0E9",
    surfaceVariant: "#49454F",
    onSurfaceVariant: "#CAC4D0",
    outline: "#938F99",
    outlineVariant: "#49454F",
    error: "#F2B8B5",
    onError: "#601410",
  },
};

export const TYPOGRAPHY_ROLES = ["display", "headline", "title", "body", "label", "numeral"] as const;
export type TypographyRole = (typeof TYPOGRAPHY_ROLES)[number];

export type TypographyToken = {
  fontSizeDp: number;
  lineHeightDp: number;
  weight: 400 | 500 | 600 | 700;
  tabularNumbers?: boolean;
};

export const TYPOGRAPHY_TOKENS: Readonly<Record<TypographyRole, TypographyToken>> = {
  display: { fontSizeDp: 30, lineHeightDp: 36, weight: 700 },
  headline: { fontSizeDp: 22, lineHeightDp: 28, weight: 600 },
  title: { fontSizeDp: 16, lineHeightDp: 22, weight: 600 },
  body: { fontSizeDp: 14, lineHeightDp: 20, weight: 400 },
  label: { fontSizeDp: 12, lineHeightDp: 16, weight: 500 },
  numeral: { fontSizeDp: 28, lineHeightDp: 34, weight: 700, tabularNumbers: true },
};

export const SHAPE_TOKENS = {
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 28,
  full: 999,
} as const;

export type ShapeRole = keyof typeof SHAPE_TOKENS;

export const SPACING_TOKENS = {
  none: 0,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 24,
  extraExtraLarge: 32,
} as const;

export type SpacingRole = keyof typeof SPACING_TOKENS;

type Rgb = { red: number; green: number; blue: number };
type Hsl = { hue: number; saturation: number; lightness: number };

function parseHex(value: string): Rgb | null {
  if (!/^#[\da-f]{6}$/i.test(value)) return null;
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}

function toHex({ red, green, blue }: Rgb): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function toHsl({ red, green, blue }: Rgb): Hsl {
  const channels = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  let hue = 0;
  const lightness = (max + min) / 2;
  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === channels[0]) hue = ((channels[1] - channels[2]) / delta) % 6;
    else if (max === channels[1]) hue = (channels[2] - channels[0]) / delta + 2;
    else hue = (channels[0] - channels[1]) / delta + 4;
  }
  return { hue: (hue * 60 + 360) % 360, saturation, lightness };
}

function fromHsl({ hue, saturation, lightness }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [red, green, blue] = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return { red: (red + match) * 255, green: (green + match) * 255, blue: (blue + match) * 255 };
}

function adjustHue(hex: string, degrees: number, mode: ColorSchemeMode): string {
  const rgb = parseHex(hex);
  if (!rgb) return DEFAULT_COLOR_SCHEMES[mode].primary;
  const hsl = toHsl(rgb);
  return toHex(fromHsl({
    hue: (hsl.hue + degrees + 360) % 360,
    saturation: Math.max(hsl.saturation, 0.28),
    lightness: mode === "light" ? 0.38 : 0.78,
  }));
}

function mixColors(first: string, second: string, secondWeight: number, mode: ColorSchemeMode): string {
  const a = parseHex(first);
  const b = parseHex(second);
  if (!a || !b) return DEFAULT_COLOR_SCHEMES[mode].primaryContainer;
  return toHex({
    red: a.red * (1 - secondWeight) + b.red * secondWeight,
    green: a.green * (1 - secondWeight) + b.green * secondWeight,
    blue: a.blue * (1 - secondWeight) + b.blue * secondWeight,
  });
}

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  return 0.2126 * linearChannel(rgb.red) + 0.7152 * linearChannel(rgb.green) + 0.0722 * linearChannel(rgb.blue);
}

export function contrastRatio(first: string, second: string): number | null {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  const [lighter, darker] = [firstLuminance, secondLuminance].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

export function resolveOnColor(background: string, mode: ColorSchemeMode = "light"): string {
  const rgb = parseHex(background);
  if (!rgb) return DEFAULT_COLOR_SCHEMES[mode].onPrimary;
  const dark = "#1D1B20";
  const light = "#FFFFFF";
  return (contrastRatio(dark, background) ?? 0) >= (contrastRatio(light, background) ?? 0) ? dark : light;
}

/**
 * Resolves the semantic roles from an optional custom accent or legacy six-color
 * palette. This is a deterministic role mapping, not Android's dynamic-color API.
 */
export function resolveColorScheme(
  mode: ColorSchemeMode,
  options: { seedColor?: string; legacyPalette?: WidgetPalette } = {},
): SemanticColorScheme {
  const fallback = DEFAULT_COLOR_SCHEMES[mode];
  const legacy = options.legacyPalette;
  const validLegacy = (value: string | undefined) => value && parseHex(value) ? value : undefined;
  const seedColor = validLegacy(options.seedColor);
  const hasLegacyColors = Boolean(legacy && [
    legacy.background,
    legacy.surface,
    legacy.text,
    legacy.muted,
    legacy.accent,
    legacy.border,
  ].some((value) => validLegacy(value)));
  if (!seedColor && !hasLegacyColors) return fallback;

  const primary = seedColor ?? validLegacy(legacy?.accent) ?? fallback.primary;
  const background = validLegacy(legacy?.background) ?? fallback.background;
  const surface = validLegacy(legacy?.surface) ?? fallback.surface;
  const onSurface = validLegacy(legacy?.text) ?? fallback.onSurface;
  const onSurfaceVariant = validLegacy(legacy?.muted) ?? fallback.onSurfaceVariant;
  const outline = validLegacy(legacy?.border) ?? fallback.outline;
  const secondary = adjustHue(primary, 60, mode);
  const tertiary = adjustHue(primary, -60, mode);
  const primaryContainer = mixColors(primary, background, mode === "light" ? 0.88 : 0.48, mode);
  const secondaryContainer = mixColors(secondary, background, mode === "light" ? 0.88 : 0.48, mode);
  const tertiaryContainer = mixColors(tertiary, background, mode === "light" ? 0.88 : 0.48, mode);

  return {
    primary,
    onPrimary: resolveOnColor(primary, mode),
    primaryContainer,
    onPrimaryContainer: resolveOnColor(primaryContainer, mode),
    secondary,
    onSecondary: resolveOnColor(secondary, mode),
    secondaryContainer,
    onSecondaryContainer: resolveOnColor(secondaryContainer, mode),
    tertiary,
    onTertiary: resolveOnColor(tertiary, mode),
    tertiaryContainer,
    onTertiaryContainer: resolveOnColor(tertiaryContainer, mode),
    background,
    onBackground: validLegacy(legacy?.text) ?? fallback.onBackground,
    surface,
    onSurface,
    surfaceVariant: mixColors(surface, background, 0.5, mode),
    onSurfaceVariant,
    outline,
    outlineVariant: validLegacy(legacy?.border) ?? fallback.outlineVariant,
    error: fallback.error,
    onError: fallback.onError,
  };
}

export function resolveTypography(role: TypographyRole, compact = false): TypographyToken {
  const token = TYPOGRAPHY_TOKENS[role];
  if (!compact || (role !== "display" && role !== "headline" && role !== "numeral")) return token;
  const fontSizeDp = role === "display" ? 24 : role === "numeral" ? 24 : 20;
  return { ...token, fontSizeDp, lineHeightDp: Math.ceil(fontSizeDp * 1.2) };
}

export function resolveShape(role: ShapeRole): number {
  return SHAPE_TOKENS[role];
}

export function resolveSpacing(role: SpacingRole): number {
  return SPACING_TOKENS[role];
}
