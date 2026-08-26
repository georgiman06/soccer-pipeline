# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone React/Vite landing page: dark green hero, Orbitron typewriter
headline "Let's Analyze Some Game!", spinning SVG soccer-ball loader, then transition to a
placeholder analyze screen.

**Architecture:** Single Vite + React app under `web/landing/`. `App.jsx` holds a `view`
state (`"landing" | "analyze"`) and switches between `LandingPage` and `AnalyzeScreen`.
`LandingPage` composes `Typewriter` (reveals headline char-by-char) and `SoccerBallLoader`
(CSS-animated SVG), then after a timeline completes calls `onDone` to flip `view`.

**Tech Stack:** React 18, Vite, plain CSS (no CSS framework), Orbitron Google Font, no
backend calls, no test framework (static animation — manual browser verification per task).

**Spec:** `docs/superpowers/specs/2026-08-26-landing-page-design.md`

## Global Constraints

- Standalone app lives at `web/landing/` — must NOT modify `pipeline/web/index.html` or
  anything under `pipeline/`.
- No backend/API calls, no file upload logic — analyze screen is an empty placeholder.
- No automated test framework required; each task ends with a manual `npm run dev` check
  described in that task's steps.
- Headline text is exactly: `Let's Analyze Some Game!`
- Background gradient: `#0a1f14` to `#123821` (dark green).
- Font: Orbitron (Google Font), bold weight for headline.

---

### Task 1: Scaffold Vite React app

**Files:**
- Create: `web/landing/package.json`
- Create: `web/landing/vite.config.js`
- Create: `web/landing/index.html`
- Create: `web/landing/src/main.jsx`
- Create: `web/landing/src/App.jsx`
- Create: `web/landing/src/index.css`

**Interfaces:**
- Produces: `App` default-exported React component rendered into `#root` by `main.jsx`.
  Later tasks import and use `App` only via this same entry point (no exports needed from
  `App` itself).

- [ ] **Step 1: Scaffold the project**

```bash
cd web/landing
npm create vite@latest . -- --template react
```

If prompted about a non-empty directory, confirm proceeding (directory will be empty on
first run since these are new files).

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

- [ ] **Step 3: Replace `src/App.jsx` with placeholder root**

```jsx
import './index.css'

function App() {
  return (
    <div className="app-root">
      <p>Landing page scaffold OK</p>
    </div>
  )
}

export default App
```

- [ ] **Step 4: Replace `src/index.css` with a minimal reset**

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #root {
  height: 100%;
}

.app-root {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a1f14;
  color: #fff;
  font-family: sans-serif;
}
```

- [ ] **Step 5: Run dev server and verify manually**

```bash
npm run dev
```

Open the printed local URL in a browser. Expected: page shows dark green background with
text "Landing page scaffold OK". Stop the server (Ctrl+C) once confirmed.

- [ ] **Step 6: Commit**

```bash
git add web/landing
git commit -m "feat: scaffold vite react app for landing page"
```

---

### Task 2: Add Orbitron font and shared color tokens

**Files:**
- Modify: `web/landing/index.html`
- Modify: `web/landing/src/index.css`

**Interfaces:**
- Produces: CSS custom properties `--bg-dark`, `--bg-light`, `--text-glow` on `:root`,
  and a `.font-orbitron` utility class. Later tasks (Task 3, 4, 5) reference these
  variable names and the class directly.

- [ ] **Step 1: Add Orbitron font link to `web/landing/index.html`**

Add inside `<head>`, before the closing `</head>` tag:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Add color tokens and font utility to `web/landing/src/index.css`**

Append to the file:

```css
:root {
  --bg-dark: #0a1f14;
  --bg-light: #123821;
  --text-glow: rgba(180, 255, 200, 0.55);
}

.font-orbitron {
  font-family: 'Orbitron', sans-serif;
}
```

- [ ] **Step 3: Verify font loads**

```bash
npm run dev
```

Open the browser, open DevTools > Network tab, reload, confirm a request to
`fonts.googleapis.com` / `fonts.gstatic.com` succeeds (status 200). Stop the server.

- [ ] **Step 4: Commit**

```bash
git add web/landing/index.html web/landing/src/index.css
git commit -m "feat: add orbitron font and color tokens"
```

---

### Task 3: Build `Typewriter` component

**Files:**
- Create: `web/landing/src/Typewriter.jsx`
- Modify: `web/landing/src/App.jsx`

**Interfaces:**
- Consumes: nothing from other components.
- Produces: default-exported `Typewriter` component with props:
  - `text: string` — full string to reveal
  - `speedMs: number` — delay between characters (default `70`)
  - `onDone?: () => void` — called once when the full string has been revealed
  Later use (Task 5, `LandingPage`) renders `<Typewriter text="..." onDone={...} />`.

- [ ] **Step 1: Create `web/landing/src/Typewriter.jsx`**

```jsx
import { useEffect, useState } from 'react'

function Typewriter({ text, speedMs = 70, onDone }) {
  const [visibleCount, setVisibleCount] = useState(0)

  useEffect(() => {
    setVisibleCount(0)
  }, [text])

  useEffect(() => {
    if (visibleCount >= text.length) {
      if (onDone) onDone()
      return
    }
    const timer = setTimeout(() => {
      setVisibleCount((count) => count + 1)
    }, speedMs)
    return () => clearTimeout(timer)
  }, [visibleCount, text, speedMs, onDone])

  return <span>{text.slice(0, visibleCount)}</span>
}

export default Typewriter
```

- [ ] **Step 2: Temporarily wire into `App.jsx` to verify manually**

Replace `App.jsx` contents with:

```jsx
import './index.css'
import Typewriter from './Typewriter'

function App() {
  return (
    <div className="app-root">
      <h1 className="font-orbitron" style={{ color: '#fff' }}>
        <Typewriter text="Let's Analyze Some Game!" onDone={() => console.log('done')} />
      </h1>
    </div>
  )
}

export default App
```

- [ ] **Step 3: Run and verify manually**

```bash
npm run dev
```

Open the browser. Expected: headline text appears one character at a time in Orbitron
font, and the browser console logs `"done"` once the full sentence has appeared. Stop the
server.

- [ ] **Step 4: Commit**

```bash
git add web/landing/src/Typewriter.jsx web/landing/src/App.jsx
git commit -m "feat: add typewriter component"
```

---

### Task 4: Build `SoccerBallLoader` component

**Files:**
- Create: `web/landing/src/SoccerBallLoader.jsx`
- Create: `web/landing/src/SoccerBallLoader.css`
- Modify: `web/landing/src/App.jsx`

**Interfaces:**
- Consumes: nothing from other components.
- Produces: default-exported `SoccerBallLoader` component with props:
  - `size: number` — pixel diameter (default `64`)
  Later use (Task 5, `LandingPage`) renders `<SoccerBallLoader size={48} />`.

- [ ] **Step 1: Create `web/landing/src/SoccerBallLoader.css`**

```css
.soccer-ball-loader {
  animation: soccer-ball-spin 1.1s linear infinite;
  display: inline-block;
}

@keyframes soccer-ball-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 2: Create `web/landing/src/SoccerBallLoader.jsx`**

```jsx
import './SoccerBallLoader.css'

function SoccerBallLoader({ size = 64 }) {
  return (
    <svg
      className="soccer-ball-loader"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Loading"
    >
      <circle cx="50" cy="50" r="48" fill="#fff" stroke="#111" strokeWidth="2" />
      <polygon points="50,30 61,38 57,51 43,51 39,38" fill="#111" />
      <polygon points="50,30 39,38 30,30 34,16 50,12" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="50,30 61,38 70,30 66,16 50,12" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="43,51 57,51 62,64 50,74 38,64" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="39,38 30,30 15,36 15,54 27,60" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="61,38 70,30 85,36 85,54 73,60" fill="#fff" stroke="#111" strokeWidth="1.5" />
    </svg>
  )
}

export default SoccerBallLoader
```

- [ ] **Step 3: Temporarily wire into `App.jsx` to verify manually**

Replace `App.jsx` contents with:

```jsx
import './index.css'
import SoccerBallLoader from './SoccerBallLoader'

function App() {
  return (
    <div className="app-root">
      <SoccerBallLoader size={80} />
    </div>
  )
}

export default App
```

- [ ] **Step 4: Run and verify manually**

```bash
npm run dev
```

Open the browser. Expected: a black/white soccer-ball pattern SVG spinning smoothly in
place. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add web/landing/src/SoccerBallLoader.jsx web/landing/src/SoccerBallLoader.css web/landing/src/App.jsx
git commit -m "feat: add spinning soccer ball loader"
```

---

### Task 5: Build `AnalyzeScreen` placeholder

**Files:**
- Create: `web/landing/src/AnalyzeScreen.jsx`
- Create: `web/landing/src/AnalyzeScreen.css`

**Interfaces:**
- Consumes: nothing.
- Produces: default-exported `AnalyzeScreen` component, no props required. Later use
  (Task 6, `App.jsx`) renders `<AnalyzeScreen />` with no props.

- [ ] **Step 1: Create `web/landing/src/AnalyzeScreen.css`**

```css
.analyze-screen {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bg-dark);
  color: #fff;
}

.analyze-screen p {
  color: #8fae9c;
  font-size: 14px;
}
```

- [ ] **Step 2: Create `web/landing/src/AnalyzeScreen.jsx`**

```jsx
import './AnalyzeScreen.css'

function AnalyzeScreen() {
  return (
    <div className="analyze-screen">
      <h2 className="font-orbitron">Analyze</h2>
      <p>Analyze screen coming soon</p>
    </div>
  )
}

export default AnalyzeScreen
```

- [ ] **Step 3: Temporarily wire into `App.jsx` to verify manually**

Replace `App.jsx` contents with:

```jsx
import './index.css'
import AnalyzeScreen from './AnalyzeScreen'

function App() {
  return <AnalyzeScreen />
}

export default App
```

- [ ] **Step 4: Run and verify manually**

```bash
npm run dev
```

Open the browser. Expected: dark green full-screen shell with "Analyze" heading in
Orbitron font and "Analyze screen coming soon" text below it. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add web/landing/src/AnalyzeScreen.jsx web/landing/src/AnalyzeScreen.css
git commit -m "feat: add analyze screen placeholder"
```

---

### Task 6: Build `LandingPage` and wire full animation timeline in `App.jsx`

**Files:**
- Create: `web/landing/src/LandingPage.jsx`
- Create: `web/landing/src/LandingPage.css`
- Modify: `web/landing/src/App.jsx`

**Interfaces:**
- Consumes: `Typewriter` (Task 3: `text`, `speedMs`, `onDone` props), `SoccerBallLoader`
  (Task 4: `size` prop), `AnalyzeScreen` (Task 5: no props).
- Produces: default-exported `LandingPage` component with props:
  - `onDone: () => void` — called after the full landing timeline (typing + pause +
    fade-out) finishes, signaling the parent to switch views.
  `App.jsx` is the final consumer — no later tasks depend on `LandingPage`'s internals.

- [ ] **Step 1: Create `web/landing/src/LandingPage.css`**

```css
.landing-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  background: radial-gradient(circle at 50% 40%, var(--bg-light), var(--bg-dark) 70%);
  transition: opacity 0.6s ease;
}

.landing-page.fading-out {
  opacity: 0;
}

.landing-headline {
  color: #f2fff5;
  font-weight: 900;
  font-size: clamp(28px, 5vw, 56px);
  text-align: center;
  text-shadow: 0 0 18px var(--text-glow);
  min-height: 1.2em;
  padding: 0 16px;
}
```

- [ ] **Step 2: Create `web/landing/src/LandingPage.jsx`**

```jsx
import { useState } from 'react'
import Typewriter from './Typewriter'
import SoccerBallLoader from './SoccerBallLoader'
import './LandingPage.css'

const HEADLINE = "Let's Analyze Some Game!"
const POST_TYPE_PAUSE_MS = 900
const FADE_DURATION_MS = 600

function LandingPage({ onDone }) {
  const [typingDone, setTypingDone] = useState(false)
  const [fadingOut, setFadingOut] = useState(false)

  function handleTypingDone() {
    setTypingDone(true)
    setTimeout(() => {
      setFadingOut(true)
      setTimeout(onDone, FADE_DURATION_MS)
    }, POST_TYPE_PAUSE_MS)
  }

  return (
    <div className={`landing-page${fadingOut ? ' fading-out' : ''}`}>
      <h1 className="landing-headline font-orbitron">
        <Typewriter text={HEADLINE} onDone={handleTypingDone} />
      </h1>
      {!typingDone && <SoccerBallLoader size={48} />}
    </div>
  )
}

export default LandingPage
```

- [ ] **Step 3: Rewrite `App.jsx` to switch between `LandingPage` and `AnalyzeScreen`**

```jsx
import { useState } from 'react'
import './index.css'
import LandingPage from './LandingPage'
import AnalyzeScreen from './AnalyzeScreen'

function App() {
  const [view, setView] = useState('landing')

  if (view === 'analyze') {
    return <AnalyzeScreen />
  }

  return <LandingPage onDone={() => setView('analyze')} />
}

export default App
```

- [ ] **Step 4: Run full flow and verify manually**

```bash
npm run dev
```

Open the browser. Expected sequence:
1. Dark green gradient background appears immediately.
2. Headline types out character by character in bold Orbitron font, soccer ball spins
   below it while typing.
3. Once typing finishes, the ball disappears, a short pause happens (~0.9s).
4. The landing content fades out (~0.6s) and the Analyze placeholder screen fades in with
   "Analyze screen coming soon".

Stop the server.

- [ ] **Step 5: Commit**

```bash
git add web/landing/src/LandingPage.jsx web/landing/src/LandingPage.css web/landing/src/App.jsx
git commit -m "feat: wire landing page animation timeline into app"
```

---

## Post-plan note

This plan builds a standalone app under `web/landing/`. It does not modify or integrate
with `pipeline/web/index.html`. Wiring the analyze screen to real video upload and the
Python inference pipeline is out of scope — track as a follow-up task/spec.
