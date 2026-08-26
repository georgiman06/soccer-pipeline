# Landing Page — Design Spec

Date: 2026-08-26

## Goal
New web landing page for soccer pipeline UI. Dark green animated hero: bold futuristic
text types out "Let's Analyze Some Game!", spinning soccer-ball loader shown while text
types, then transitions into a placeholder analyze screen shell.

## Scope
- New standalone Vite + React app under `web/landing/` (does not touch existing
  `pipeline/web/index.html` test bench).
- Landing animation + transition to an empty placeholder "analyze" screen only.
- No file upload, no backend/pipeline wiring — later task.

## Visual design
- Background: dark green gradient (deep forest green `#0a1f14` to `#123821`), subtle
  radial vignette, faint pitch-line texture optional.
- Font: Orbitron (Google Font) — bold, geometric, futuristic. Loaded via `@font-face`/link.
- Headline: "Let's Analyze Some Game!" typed out letter-by-letter (typewriter effect),
  bold, large, centered, white/light-green text with slight glow.
- Loader: SVG soccer ball (black pentagon / white hexagon pattern) spinning via CSS
  `@keyframes rotate`, positioned near/below headline while typing, or as a stand-alone
  "..." replacement — used both during initial load and as page transition indicator.
- Transition: after typing completes + short pause, fade/slide out landing content,
  fade in placeholder analyze screen (empty shell, just a header + "Analyze screen
  coming soon" placeholder).

## Components
- `App.jsx` — root, holds view state (`landing` | `analyze`), renders either.
- `LandingPage.jsx` — background, headline, orchestrates typewriter + loader + transition
  timing, calls `onDone` callback to switch view.
- `Typewriter.jsx` — small reusable component: given a string, reveals it char by char.
- `SoccerBallLoader.jsx` — SVG soccer ball with CSS spin animation, size prop.
- `AnalyzeScreen.jsx` — placeholder shell for next task.
- `styles` — CSS modules or plain CSS file per component; Orbitron font import.

## Data flow
Pure client-side state, no API calls. `App` holds `view` state; `LandingPage` signals
completion via callback prop after animation timeline finishes.

## Testing
Manual: `npm run dev`, view in browser, confirm animation timing, font render, ball spin,
transition. No automated tests needed for a static animation.

## Out of scope (future tasks)
- Video/game upload UI
- Wiring to Python inference pipeline
- Multi-page routing
