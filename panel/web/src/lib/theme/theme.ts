const THEME_STORAGE_KEY = 'ui-theme'
const DEFAULT_THEME = 'light'

const THEMES = ['light', 'dark', 'cupcake', 'synthwave'] as const

export type ThemeName = (typeof THEMES)[number]

export function getAvailableThemes(): readonly ThemeName[] {
  return THEMES
}

export function getTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)?.trim()
    if (raw && THEMES.includes(raw as ThemeName)) return raw as ThemeName
  } catch { /* Use the default when browser storage is unavailable. */ }
  return DEFAULT_THEME
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* The selected theme still applies to this page. */ }
}
