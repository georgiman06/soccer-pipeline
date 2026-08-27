const API_BASE = import.meta.env.VITE_API_URL || ''

export function apiUrl(path) {
  if (!path) return API_BASE
  if (path.startsWith('/')) return `${API_BASE}${path}`
  return `${API_BASE}/${path}`
}
