/**
 * Modern UI Theme Configuration
 * A cohesive color palette for the coding agent CLI
 */

export const theme = {
  // Primary colors
  primary: "cyan",
  primaryBright: "cyanBright",

  // Secondary colors
  secondary: "magenta",
  secondaryBright: "magentaBright",

  // Accent colors
  accent: "yellow",
  accentBright: "yellowBright",

  // Semantic colors
  success: "green",
  successBright: "greenBright",
  warning: "yellow",
  warningBright: "yellowBright",
  error: "red",
  errorBright: "redBright",
  info: "blue",
  infoBright: "blueBright",

  // UI element colors
  ai: { badge: "cyanBright", border: "cyan", text: "white" },
  user: { badge: "magentaBright", border: "magenta", text: "white" },
  tool: {
    name: "yellowBright",
    input: "gray",
    output: "greenBright",
    border: "yellow",
  },
  input: { border: "cyan", placeholder: "gray" },
  status: { tokens: "gray", progress: "cyanBright" },
} as const;

// Gradient presets for ink-gradient
export const gradients = {
  title: "cristal", // Modern blue-purple gradient
  status: "pastel",
  accent: "morning",
} as const;

// Box styles
export const boxStyles = {
  message: "round",
  input: "round",
  tool: "single",
  approval: "double",
} as const;
