import { useEffect, useRef, useState } from 'react'
import './PipelineScreen.css'
import { apiUrl } from './config.js'

const TOTAL_FRAMES = 750
const FPS = 25
const SEQ = 'SNGS-027'

const MOCK_MATCH = {
  home: { code: 'BAY', name: 'Bayern München', score: 2, color: '#dc2626' },
  away: { code: 'RMA', name: 'Real Madrid', score: 1, color: '#ffd23f' },
  minute: 70,
  half: '2nd Half',
  competition: 'UEFA CHAMPIONS LEAGUE',
  venue: 'ALLIANZ ARENA, MUNICH',
}

const MOCK_EVENTS = [
  { min: 38, type: 'YELLOW', text: 'Yellow Card — Bayern (Kimmich)', team: 1 },
  { min: 55, type: 'GOAL', text: 'Goal — Real Madrid (Bellingham)', team: 2 },
  { min: 67, type: 'GOAL', text: 'Goal — Bayern München (Kane)', team: 1 },
]

const MOCK_STATS = {
  shots: [10, 6],
  onTarget: [5, 3],
  xG: [2.26, 1.36],
  passes: [434, 308],
  passAcc: [98, 86],
}

const OVERLAY_MODES = [
  { id: 'raw', title: 'Raw View', sub: 'Player positions only', icon: '◫' },
  { id: 'heat', title: 'Heatmap', sub: 'Spatial activity density', icon: '◉' },
  { id: 'ball', title: 'Ball Tracking', sub: 'Ball trajectory + control zones', icon: '◎' },
]

function fmtTime(idx) {
  const s = Math.floor(idx / FPS)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fmtTimePlain(idx) {
  return `${Math.floor(idx / FPS / 60)}:${String(Math.floor(idx / FPS) % 60).padStart(2, '0')}:${String(idx % FPS).padStart(2, '0').slice(0, 2)}`
}

function buildBars(stats) {
  const max = (a, b) => Math.max(a, b, 1)
  return [
    { label: 'SHOTS', t1: stats.shots[0], t2: stats.shots[1], max: max(...stats.shots) },
    { label: 'ON TARGET', t1: stats.onTarget[0], t2: stats.onTarget[1], max: max(...stats.onTarget) },
    { label: 'XG', t1: stats.xG[0], t2: stats.xG[1], max: max(...stats.xG), dec: 2 },
    { label: 'PASSES', t1: stats.passes[0], t2: stats.passes[1], max: max(...stats.passes) },
    { label: 'PASS ACC.', t1: stats.passAcc[0], t2: stats.passAcc[1], max: 100, suffix: '%' },
  ]
}

function PossessionDonut({ p1, p2 }) {
  const R = 24
  const C = 2 * Math.PI * R
  const t1Frac = p1 / 100
  const t1Len = C * t1Frac
  return (
    <div className="poss-donut">
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--border-mid)" strokeWidth="6" />
        <circle
          cx="32" cy="32" r={R} fill="none"
          stroke="var(--team1)" strokeWidth="6"
          strokeDasharray={`${t1Len} ${C}`}
          strokeLinecap="butt"
        />
        <circle
          cx="32" cy="32" r={R} fill="none"
          stroke="var(--team2)" strokeWidth="6"
          strokeDasharray={`${C * (p2 / 100)} ${C}`}
          strokeDashoffset={-t1Len}
          strokeLinecap="butt"
        />
      </svg>
      <div className="poss-donut-center">
        <div className="poss-ball" />
        <div>BALL</div>
      </div>
    </div>
  )
}

function MetricCard({ label, value, unit, delta, dir }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value-row">
        <span className="metric-value">{value}</span>
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {delta != null && (
        <div className={`metric-delta ${dir || 'up'}`}>{delta}</div>
      )}
    </div>
  )
}

function BarRow({ row }) {
  const p1 = (row.t1 / row.max) * 100
  const p2 = (row.t2 / row.max) * 100
  const fmt = (v) => (row.dec != null ? v.toFixed(row.dec) : v) + (row.suffix || '')
  return (
    <div className="bar-row">
      <span className="val t1">{fmt(row.t1)}</span>
      <span className="bar-track t1" style={{ '--p': `${p1}%` }} />
      <span className="lbl">{row.label}</span>
      <span className="bar-track t2" style={{ '--p': `${p2}%` }} />
      <span className="val t2">{fmt(row.t2)}</span>
    </div>
  )
}

function PipelineScreen() {
  const st = useRef({
    idx: 1,
    playing: false,
    busy: false,
    pending: null,
    teamColors: [MOCK_MATCH.home.color, MOCK_MATCH.away.color],
    overlayMode: 'heat',
    showMarkers: true,
    showGT: false,
    showLines: true,
    showIDs: true,
  }).current
  const [idx, setIdx] = useState(1)
  const [overlayMode, setOverlayMode] = useState('heat')
  const [fps, setFps] = useState(0)

  const frameRef = useRef(null)
  const overlayRef = useRef(null)
  const pitchRef = useRef(null)
  const seqSelRef = useRef(null)
  const playBtnRef = useRef(null)
  const speedSelRef = useRef(null)
  const alive = useRef(true)

  function setOverlay(id) {
    st.overlayMode = id
    setOverlayMode(id)
  }

  function setStatus() { /* legacy no-op */ }

  function chip() { return '' }

  function drawPitch() {
    const c = pitchRef.current
    if (!c) return null
    const ctx = c.getContext('2d')
    const W = 105, H = 68
    const m = 6
    const cw = c.width, ch = c.height
    const s = Math.min((cw - 2 * m) / W, (ch - 2 * m) / H)
    const X = (x) => m + x * s
    const Y = (y) => m + y * s
    ctx.clearRect(0, 0, cw, ch)

    // grass stripes
    const stripes = 10
    const sw = (W * s) / stripes
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1f6b3a' : '#195e30'
      ctx.fillRect(X(i * (W / stripes)), Y(0), sw + 1, H * s)
    }
    // subtle vignette
    const grad = ctx.createRadialGradient(X(W / 2), Y(H / 2), 10, X(W / 2), Y(H / 2), W * s * 0.7)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.35)')
    ctx.fillStyle = grad
    ctx.fillRect(X(0), Y(0), W * s, H * s)

    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.lineWidth = 1.5
    ctx.lineCap = 'butt'
    ctx.strokeRect(X(0), Y(0), W * s, H * s)

    ctx.beginPath()
    ctx.moveTo(X(52.5), Y(0)); ctx.lineTo(X(52.5), Y(68)); ctx.stroke()

    ctx.beginPath()
    ctx.arc(X(52.5), Y(34), 9.15 * s, 0, 2 * Math.PI); ctx.stroke()

    ctx.beginPath()
    ctx.arc(X(52.5), Y(34), 0.6 * s, 0, 2 * Math.PI)
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fill()

    for (const side of [[0, 1], [105, -1]]) {
      const [gx, dir] = side
      const x1 = X(Math.min(gx, gx + 16.5 * dir))
      ctx.strokeRect(x1, Y(13.84), 16.5 * s, 40.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 5.5 * dir)), Y(24.84), 5.5 * s, 18.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 2 * dir)), Y(34 - 3.66), 2 * s, 7.32 * s)
      const penSpot = dir === 1 ? [11, 34] : [94, 34]
      ctx.beginPath()
      ctx.arc(X(penSpot[0]), Y(penSpot[1]), 0.6 * s, 0, 2 * Math.PI)
      ctx.fill()
      const arcX = dir === 1 ? 11 : 94
      const arcStart = dir === 1 ? 0.55 : 2.55
      const arcEnd = dir === 1 ? 5.75 : 3.75
      ctx.beginPath()
      ctx.arc(X(arcX), Y(34), 8 * s, arcStart * Math.PI, arcEnd * Math.PI); ctx.stroke()
    }
    return { X, Y, s, ctx }
  }

  function inField(p) {
    return p && p[0] > -2 && p[0] < 107 && p[1] > -2 && p[1] < 70
  }

  function drawPlayer(ctx, x, y, num, color, radius = 9) {
    // shadow
    ctx.beginPath()
    ctx.arc(x + 1, y + 1, radius, 0, 2 * Math.PI)
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fill()
    // ring
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.stroke()
    // number
    ctx.fillStyle = color === '#ffd23f' ? '#0b1424' : '#fff'
    ctx.font = `700 ${Math.round(radius * 0.95)}px 'Segoe UI', system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(num), x, y + 0.5)
    ctx.textBaseline = 'alphabetic'
  }

  function drawBall(ctx, x, y) {
    ctx.beginPath()
    ctx.arc(x + 1, y + 1, 5, 0, 2 * Math.PI)
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, 2 * Math.PI)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.strokeStyle = '#0b1424'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  function drawZone(ctx, pts, color) {
    if (pts.length < 3) return
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }

  // Build mock data once; in real mode this is replaced by /api/process
  const mockData = useRef(null)
  function getMockData() {
    if (mockData.current) return mockData.current
    const t1Color = MOCK_MATCH.home.color
    const t2Color = MOCK_MATCH.away.color
    const t1Players = [
      { id: 5, num: 5, team: 0, pitch: [28, 38] },
      { id: 8, num: 8, team: 0, pitch: [42, 30] },
      { id: 11, num: 11, team: 0, pitch: [55, 26] },
      { id: 16, num: 16, team: 0, pitch: [60, 38] },
      { id: 19, num: 19, team: 0, pitch: [38, 50] },
    ]
    const t2Players = [
      { id: 3, num: 3, team: 1, pitch: [78, 18] },
      { id: 5, num: 5, team: 1, pitch: [82, 48] },
      { id: 6, num: 6, team: 1, pitch: [72, 36] },
      { id: 11, num: 11, team: 1, pitch: [65, 32] },
    ]
    const t1Zone = [[18, 50], [25, 22], [48, 20], [55, 36], [60, 50], [40, 56]]
    const t2Zone = [[55, 36], [60, 18], [88, 12], [95, 30], [92, 50], [70, 56], [60, 50]]
    const ball = { pitch: [62, 30] }
    mockData.current = { t1Players, t2Players, t1Zone, t2Zone, ball, t1Color, t2Color }
    return mockData.current
  }

  function render() {
    const c = pitchRef.current
    if (!c) return
    const { X, Y, ctx } = drawPitch() || {}
    if (!ctx) return
    const d = getMockData()

    // team control zones (voronoi-like blob)
    if (st.overlayMode === 'heat' || st.overlayMode === 'ball') {
      ctx.save()
      ctx.globalAlpha = 0.22
      drawZone(ctx, d.t1Zone.map((p) => [X(p[0]), Y(p[1])]), d.t1Color)
      drawZone(ctx, d.t2Zone.map((p) => [X(p[0]), Y(p[1])]), d.t2Color)
      ctx.restore()
    }

    // heatmap blob
    if (st.overlayMode === 'heat') {
      const cx = X(50), cy = Y(36)
      const rg = ctx.createRadialGradient(cx, cy, 4, cx, cy, 22)
      rg.addColorStop(0, 'rgba(255, 150, 40, 0.55)')
      rg.addColorStop(0.5, 'rgba(255, 120, 40, 0.28)')
      rg.addColorStop(1, 'rgba(255, 80, 40, 0)')
      ctx.fillStyle = rg
      ctx.fillRect(X(0), Y(0), 105, 68)
    }

    // players
    for (const p of d.t1Players) drawPlayer(ctx, X(p.pitch[0]), Y(p.pitch[1]), p.num, d.t1Color, 9)
    for (const p of d.t2Players) drawPlayer(ctx, X(p.pitch[0]), Y(p.pitch[1]), p.num, d.t2Color, 9)

    // ball
    drawBall(ctx, X(d.ball.pitch[0]), Y(d.ball.pitch[1]))
  }

  useEffect(() => { render() }, [overlayMode])

  function drawOverlay() {
    const img = frameRef.current
    const cv = overlayRef.current
    if (!img || !cv) return
    if (!img.naturalWidth) {
      requestAnimationFrame(drawOverlay)
      return
    }
    const scale = img.clientWidth / img.naturalWidth
    cv.width = img.clientWidth
    cv.height = img.clientHeight
    cv.style.left = img.offsetLeft + 'px'
    cv.style.top = img.offsetTop + 'px'
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, cv.width, cv.height)
  }

  function load() {
    if (frameRef.current) frameRef.current.src = apiUrl(`/api/frame/${SEQ}/${st.idx}`)
    fetch(apiUrl(`/api/process/${SEQ}/${st.idx}`)).catch(() => {})
    drawOverlay()
    render()
    st.busy = false
  }

  function tick() {
    if (!st.playing) return
    if (st.idx < TOTAL_FRAMES) {
      st.idx++
      setIdx(st.idx)
      load()
    } else {
      st.playing = false
      if (playBtnRef.current) playBtnRef.current.textContent = 'Play'
      return
    }
    setTimeout(() => alive.current && tick(), +speedSelRef.current?.value || 40)
  }

  function onPlay() {
    st.playing = !st.playing
    if (playBtnRef.current) playBtnRef.current.textContent = st.playing ? 'Pause' : 'Play'
    if (st.playing) tick()
  }

  function onPrev() {
    if (st.idx > 1) { st.idx--; setIdx(st.idx); load() }
  }

  function onNext() {
    if (st.idx < TOTAL_FRAMES) { st.idx++; setIdx(st.idx); load() }
  }

  function onSlider(e) {
    st.idx = +e.target.value
    setIdx(st.idx)
    load()
  }

  useEffect(() => {
    alive.current = true
    fetch(apiUrl('/api/sequences'))
      .then((r) => r.json())
      .then((s) => {
        if (!alive.current) return
        if (seqSelRef.current) seqSelRef.current.innerHTML = s.map((x) => `<option>${x}</option>`).join('')
        st.idx = 1
        setIdx(1)
        load()
      })
      .catch(() => load())
    return () => { alive.current = false }
  }, [])

  const bars = buildBars(MOCK_STATS)
  const t1Poss = 61, t2Poss = 39

  return (
    <div className="pipeline-screen">
      {/* TOP BAR */}
      <header className="pipeline-topbar">
        <div className="pipeline-topbar-brand">
          <span className="pipeline-topbar-logo">S</span>
          <span>SPORTVIZ PRO</span>
          <span className="pipeline-topbar-crumb">/ Analytics</span>
        </div>
        <div className="pipeline-topbar-divider" />
        <div className="pill pill-live">LIVE</div>
        <div className="pipeline-topbar-right">
          <span className="pipeline-topbar-match">{MOCK_MATCH.competition}</span>
          <span className="pipeline-topbar-min">{MOCK_MATCH.minute}'</span>
        </div>
      </header>

      {/* 2x2 GRID */}
      <main className="pipeline-grid">
        {/* TOP-LEFT: VIDEO */}
        <section className="pipeline-video-panel">
          <div className="panel-label">
            <div className="panel-label-main">MATCH FEED</div>
            <div className="pill pill-live">LIVE</div>
          </div>
          <div className="pipeline-video-wrapper">
            <img ref={frameRef} alt="Live match feed" />
            <canvas ref={overlayRef}></canvas>
            <div className="pipeline-score-overlay">
              <span className="pipeline-score-team t1">{MOCK_MATCH.home.code}</span>
              <span className="pipeline-score-cell">{MOCK_MATCH.home.score}</span>
              <span className="pipeline-score-cell">{MOCK_MATCH.away.score}</span>
              <span className="pipeline-score-team t2">{MOCK_MATCH.away.code}</span>
              <span className="pipeline-score-min">{MOCK_MATCH.minute}'</span>
            </div>
            <div className="pipeline-venue">
              {MOCK_MATCH.competition} · {MOCK_MATCH.venue}
            </div>
            <div className="pipeline-half">{MOCK_MATCH.half}</div>
            <div className="pipeline-icons">
              <div className="pipeline-icon-btn">+</div>
              <div className="pipeline-icon-btn">−</div>
              <div className="pipeline-icon-btn">⤢</div>
            </div>
          </div>
          <div className="pipeline-event-ticker">
            {MOCK_EVENTS.map((e, i) => (
              <div className="pipeline-event-item" key={i}>
                <span className="pipeline-event-dot" />
                <span className="pipeline-event-min">{e.min}'</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
          <div className="pipeline-slider-row">
            <span className="pipeline-slider-time current">{fmtTime(idx)}</span>
            <input type="range" min="1" max={TOTAL_FRAMES} value={idx} onInput={onSlider} />
            <span className="pipeline-slider-time">{fmtTime(TOTAL_FRAMES)}</span>
            <button ref={playBtnRef} onClick={onPlay} style={{
              background: 'transparent', border: '1px solid var(--border-mid)', color: 'var(--text)',
              padding: '3px 12px', fontSize: 11, fontFamily: 'Consolas, monospace',
              letterSpacing: '0.08em', textTransform: 'uppercase', borderRadius: 3, cursor: 'pointer',
            }}>Play</button>
            <button onClick={onPrev} style={{
              background: 'transparent', border: '1px solid var(--border-mid)', color: 'var(--text-mid)',
              padding: '3px 8px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
            }}>◀</button>
            <button onClick={onNext} style={{
              background: 'transparent', border: '1px solid var(--border-mid)', color: 'var(--text-mid)',
              padding: '3px 8px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
            }}>▶</button>
            <select ref={speedSelRef} defaultValue="40" style={{
              background: 'var(--bg-panel)', border: '1px solid var(--border-mid)', color: 'var(--text-mid)',
              padding: '2px 6px', fontSize: 10, fontFamily: 'Consolas, monospace', borderRadius: 3,
            }}>
              <option value="80">0.5x</option>
              <option value="40">1x</option>
              <option value="20">2x</option>
            </select>
          </div>
        </section>

        {/* TOP-RIGHT: 2D PITCH */}
        <section className="pipeline-pitch-panel">
          <div className="panel-label">
            <div className="panel-label-main">
              <span>2D PITCH</span>
              <span className="panel-label-sub">· LIVE MOVEMENT</span>
            </div>
            <div className="pill pill-tracking">TRACKING</div>
          </div>
          <div className="pipeline-pitch-canvas-wrap">
            <canvas ref={pitchRef} width="640" height="440" className="pipeline-pitch-canvas" />
          </div>
          <div className="pitch-toolbar">
            <label>
              <input type="checkbox" defaultChecked onChange={(e) => { st.showMarkers = e.target.checked; render() }} />
              Markers
            </label>
            <label>
              <input type="checkbox" onChange={(e) => { st.showLines = e.target.checked; render() }} />
              Voronoi
            </label>
            <label>
              <input type="checkbox" defaultChecked onChange={(e) => { st.showIDs = e.target.checked; render() }} />
              IDs
            </label>
            <label>
              <input type="checkbox" onChange={(e) => { st.showGT = e.target.checked; render() }} />
              Ground Truth
            </label>
          </div>
        </section>

        {/* BOTTOM-LEFT: ANALYSIS OVERLAY + METRICS */}
        <section className="pipeline-bl-panel">
          <div className="panel-label">
            <div className="panel-label-main">ANALYSIS OVERLAY</div>
          </div>
          <div>
            {OVERLAY_MODES.map((m) => (
              <div
                key={m.id}
                className={`overlay-row ${overlayMode === m.id ? 'active' : ''}`}
                onClick={() => setOverlay(m.id)}
              >
                <div className="overlay-radio" />
                <div className="overlay-icon">{m.icon}</div>
                <div className="overlay-content">
                  <div className="overlay-title">{m.title}</div>
                  <div className="overlay-sub">{m.sub}</div>
                </div>
                <div className="pill pill-active">ACTIVE</div>
              </div>
            ))}
          </div>
          <div className="panel-label">
            <div className="panel-label-main">MATCH METRICS</div>
            <div className="panel-label-sub">15:59:09</div>
          </div>
          <div className="metric-grid">
            <MetricCard label="AVG SPEED" value="8.4" unit="km/h" delta="+0.3" dir="up" />
            <MetricCard label="DISTANCE" value="62.1" unit="km" delta="+2.1" dir="up" />
            <MetricCard label="SPRINTS" value="184" unit="total" delta="−4" dir="down" />
            <MetricCard label="INTENSITY" value="87" unit="%" delta="+1.2" dir="up" />
          </div>
        </section>

        {/* BOTTOM-RIGHT: STATS */}
        <section className="pipeline-br-panel">
          <div className="panel-label">
            <div className="panel-label-main">MATCH STATS</div>
            <div className="panel-label-sub">· API</div>
            <div style={{ marginLeft: 'auto' }}>
              <span className="stats-time">15:59:09</span>
            </div>
          </div>
          <div className="score-row">
            <div className="score-team t1">
              <span className="score-dot t1" />
              <span>{MOCK_MATCH.home.name}</span>
            </div>
            <div className="score-numbers">
              <span className="score-num t1">{MOCK_MATCH.home.score}</span>
              <span className="score-dash">:</span>
              <span className="score-num t2">{MOCK_MATCH.away.score}</span>
            </div>
            <div className="score-team t2">
              <span>{MOCK_MATCH.away.name}</span>
              <span className="score-dot t2" />
            </div>
          </div>
          <div className="poss-row">
            <div className="poss-left">
              <div className="poss-pct">{t1Poss}%</div>
              <div className="poss-label">POSS</div>
            </div>
            <PossessionDonut p1={t1Poss} p2={t2Poss} />
            <div className="poss-right">
              <div className="poss-pct">{t2Poss}%</div>
              <div className="poss-label">POSS</div>
            </div>
          </div>
          <div className="bar-rows">
            {bars.map((b) => <BarRow key={b.label} row={b} />)}
          </div>
        </section>
      </main>
    </div>
  )
}

export default PipelineScreen
