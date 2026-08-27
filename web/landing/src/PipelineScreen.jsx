import { useEffect, useRef, useState } from 'react'
import './PipelineScreen.css'
import { apiUrl } from './config.js'

const TOTAL_FRAMES = 750
const FPS = 25
const SEQ = 'SNGS-027'

const OVERLAY_MODES = [
  { id: 'raw', title: 'Raw View', sub: 'Player positions only', icon: '◫' },
  { id: 'heat', title: 'Heatmap', sub: 'Spatial activity density', icon: '◉' },
  { id: 'ball', title: 'Ball Tracking', sub: 'Ball trajectory + control zones', icon: '◎' },
]

const PITCH_W = 105
const PITCH_H = 68

function fmtTime(idx) {
  const s = Math.floor(idx / FPS)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function distM(a, b) {
  return Math.hypot((a[0] - b[0]) || 0, (a[1] - b[1]) || 0)
}

function nearestPlayerTeam(players, ballPitch) {
  if (!ballPitch || !players.length) return null
  let best = null
  let bestD = Infinity
  for (const p of players) {
    if (!p.pitch) continue
    const d = distM(p.pitch, ballPitch)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best && bestD < 4 ? best.team : null
}

function inAttackThird(p, team) {
  if (!p) return false
  if (team === 0) return p[0] < 16.5 && p[0] > 0
  if (team === 1) return p[0] > 88.5 && p[0] < 105
  return false
}

function inBox(p, team) {
  if (!p) return false
  if (team === 0) return p[0] < 16.5 && p[1] > 13.84 && p[1] < 54.16
  if (team === 1) return p[0] > 88.5 && p[1] > 13.84 && p[1] < 54.16
  return false
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

function PossessionDonut({ p1, p2 }) {
  const R = 24
  const C = 2 * Math.PI * R
  const t1Frac = p1 / 100
  const t1Len = C * t1Frac
  return (
    <div className="poss-donut">
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--border-mid)" strokeWidth="6" />
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--team1)" strokeWidth="6"
          strokeDasharray={`${t1Len} ${C}`} strokeLinecap="butt" />
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--team2)" strokeWidth="6"
          strokeDasharray={`${C * (p2 / 100)} ${C}`} strokeDashoffset={-t1Len} strokeLinecap="butt" />
      </svg>
      <div className="poss-donut-center">
        <div className="poss-ball" />
        <div>BALL</div>
      </div>
    </div>
  )
}

function PipelineScreen() {
  const st = useRef({
    idx: 1,
    playing: false,
    busy: false,
    pending: null,
    seq: null,
    seqOptions: [],
    teamColors: ['#4d4f8a', '#c0c6db'],
    overlayMode: 'heat',
    history: [],
    analytics: {
      possT1: 0,
      possT2: 0,
      lastTeam: null,
      distanceT1: 0,
      distanceT2: 0,
      sprintFramesT1: 0,
      sprintFramesT2: 0,
      shotsT1: 0,
      shotsT2: 0,
      passesT1: 0,
      passesT2: 0,
      territoryT1: 0,
      territoryT2: 0,
      ballInBoxT1: 0,
      ballInBoxT2: 0,
      recentEvents: [],
    },
  }).current

  const [idx, setIdx] = useState(1)
  const [overlayMode, setOverlayMode] = useState('heat')
  const [, forceTick] = useState(0)
  const [clock, setClock] = useState(() => new Date())

  const frameRef = useRef(null)
  const overlayRef = useRef(null)
  const pitchRef = useRef(null)
  const seqSelRef = useRef(null)
  const playBtnRef = useRef(null)
  const speedSelRef = useRef(null)
  const alive = useRef(true)
  const lastDrawRef = useRef(null)

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  function setOverlay(id) {
    st.overlayMode = id
    setOverlayMode(id)
    render()
  }

  function drawPitch() {
    const c = pitchRef.current
    if (!c) return null
    const ctx = c.getContext('2d')
    const m = 6
    const cw = c.width, ch = c.height
    const s = Math.min((cw - 2 * m) / PITCH_W, (ch - 2 * m) / PITCH_H)
    const X = (x) => m + x * s
    const Y = (y) => m + y * s
    ctx.clearRect(0, 0, cw, ch)

    const stripes = 10
    const sw = (PITCH_W * s) / stripes
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1f6b3a' : '#195e30'
      ctx.fillRect(X(i * (PITCH_W / stripes)), Y(0), sw + 1, PITCH_H * s)
    }
    const grad = ctx.createRadialGradient(X(PITCH_W / 2), Y(PITCH_H / 2), 10, X(PITCH_W / 2), Y(PITCH_H / 2), PITCH_W * s * 0.7)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.35)')
    ctx.fillStyle = grad
    ctx.fillRect(X(0), Y(0), PITCH_W * s, PITCH_H * s)

    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(X(0), Y(0), PITCH_W * s, PITCH_H * s)

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
      ctx.strokeRect(X(Math.min(gx, gx + 16.5 * dir)), Y(13.84), 16.5 * s, 40.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 5.5 * dir)), Y(24.84), 5.5 * s, 18.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 2 * dir)), Y(34 - 3.66), 2 * s, 7.32 * s)
      const penSpot = dir === 1 ? [11, 34] : [94, 34]
      ctx.beginPath(); ctx.arc(X(penSpot[0]), Y(penSpot[1]), 0.6 * s, 0, 2 * Math.PI); ctx.fill()
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
    ctx.beginPath(); ctx.arc(x + 1, y + 1, radius, 0, 2 * Math.PI)
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = color; ctx.fill()
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke()
    ctx.fillStyle = color.toLowerCase() === '#ffd23f' ? '#0b1424' : '#fff'
    ctx.font = `700 ${Math.round(radius * 0.95)}px 'Segoe UI', system-ui, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(String(num), x, y + 0.5)
    ctx.textBaseline = 'alphabetic'
  }

  function drawBall(ctx, x, y) {
    ctx.beginPath(); ctx.arc(x + 1, y + 1, 5, 0, 2 * Math.PI)
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI)
    ctx.fillStyle = '#fff'; ctx.fill()
    ctx.strokeStyle = '#0b1424'; ctx.lineWidth = 1; ctx.stroke()
  }

  function render() {
    const c = pitchRef.current
    if (!c) return
    const pitch = drawPitch()
    if (!pitch) return
    const { X, Y, ctx } = pitch
    const d = st.pending
    if (!d) return
    const players = (d.players || []).filter((p) => p.pitch && inField(p.pitch))
    const t1Color = (d.team_colors && d.team_colors[0]) || st.teamColors[0]
    const t2Color = (d.team_colors && d.team_colors[1]) || st.teamColors[1]
    st.teamColors = [t1Color, t2Color]

    // ball trail
    if (st.overlayMode === 'ball') {
      const recent = st.history.slice(-30)
      ctx.save()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      let started = false
      for (const h of recent) {
        if (!h.ballPitch) continue
        const p = [X(h.ballPitch[0]), Y(h.ballPitch[1])]
        if (!started) { ctx.moveTo(p[0], p[1]); started = true }
        else ctx.lineTo(p[0], p[1])
      }
      ctx.stroke()
      ctx.restore()
    }

    // heatmap (movement density — overlap of all recent positions)
    if (st.overlayMode === 'heat') {
      const recent = st.history.slice(-90)
      ctx.save()
      for (const h of recent) {
        if (!h.ballPitch) continue
        const x = X(h.ballPitch[0]), y = Y(h.ballPitch[1])
        const rg = ctx.createRadialGradient(x, y, 0, x, y, 14)
        rg.addColorStop(0, 'rgba(255,150,40,0.18)')
        rg.addColorStop(1, 'rgba(255,80,40,0)')
        ctx.fillStyle = rg
        ctx.fillRect(x - 14, y - 14, 28, 28)
      }
      ctx.restore()
    }

    // team control zones (simple convex hull from team players)
    function hull(pts) {
      if (pts.length < 3) return pts
      let left = 0
      for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[left][0]) left = i
      const out = []
      let p = left, q
      do {
        out.push(pts[p])
        q = (p + 1) % pts.length
        for (let i = 0; i < pts.length; i++) {
          const cross = (pts[q][0] - pts[p][0]) * (pts[i][1] - pts[p][1]) - (pts[q][1] - pts[p][1]) * (pts[i][0] - pts[p][0])
          if (cross < 0) q = i
        }
        p = q
      } while (p !== left)
      return out
    }

    const t1Pts = players.filter((p) => p.team === 0).map((p) => [X(p.pitch[0]), Y(p.pitch[1])])
    const t2Pts = players.filter((p) => p.team === 1).map((p) => [X(p.pitch[0]), Y(p.pitch[1])])
    if ((st.overlayMode === 'heat' || st.overlayMode === 'ball') && t1Pts.length >= 3) {
      const h1 = hull(t1Pts)
      ctx.beginPath(); ctx.moveTo(h1[0][0], h1[0][1])
      for (let i = 1; i < h1.length; i++) ctx.lineTo(h1[i][0], h1[i][1])
      ctx.closePath()
      ctx.fillStyle = hexA(t1Color, 0.18); ctx.fill()
    }
    if ((st.overlayMode === 'heat' || st.overlayMode === 'ball') && t2Pts.length >= 3) {
      const h2 = hull(t2Pts)
      ctx.beginPath(); ctx.moveTo(h2[0][0], h2[0][1])
      for (let i = 1; i < h2.length; i++) ctx.lineTo(h2[i][0], h2[i][1])
      ctx.closePath()
      ctx.fillStyle = hexA(t2Color, 0.18); ctx.fill()
    }

    for (const p of players) {
      const c = p.team === 0 ? t1Color : t2Color
      const r = p.coasting ? 7 : 9
      ctx.globalAlpha = p.coasting ? 0.55 : 1
      drawPlayer(ctx, X(p.pitch[0]), Y(p.pitch[1]), p.id != null ? p.id : '?', c, r)
    }
    ctx.globalAlpha = 1

    if (d.ball && d.ball.pitch && inField(d.ball.pitch)) {
      drawBall(ctx, X(d.ball.pitch[0]), Y(d.ball.pitch[1]))
    }
  }

  function hexA(hex, a) {
    if (!hex || !hex.startsWith('#')) return `rgba(255,255,255,${a})`
    const h = hex.slice(1)
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const r = parseInt(n.slice(0, 2), 16)
    const g = parseInt(n.slice(2, 4), 16)
    const b = parseInt(n.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }

  function drawOverlay() {
    const img = frameRef.current
    const cv = overlayRef.current
    if (!img || !cv) return
    if (!img.naturalWidth) { requestAnimationFrame(drawOverlay); return }
    const scale = img.clientWidth / img.naturalWidth
    cv.width = img.clientWidth
    cv.height = img.clientHeight
    cv.style.left = img.offsetLeft + 'px'
    cv.style.top = img.offsetTop + 'px'
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, cv.width, cv.height)
    const d = st.pending
    if (!d) return

    if (d.overlay_lines) {
      ctx.strokeStyle = 'rgba(255,45,106,0.85)'
      ctx.lineWidth = 1.5
      for (const line of d.overlay_lines) {
        ctx.beginPath()
        ctx.moveTo(line[0][0] * scale, line[0][1] * scale)
        ctx.lineTo(line[1][0] * scale, line[1][1] * scale)
        ctx.stroke()
      }
    }
  }

  function updateAnalytics(d) {
    if (!d) return
    const a = st.analytics
    const players = (d.players || []).filter((p) => p.pitch && inField(p.pitch))
    const ballPitch = d.ball && d.ball.pitch ? d.ball.pitch : null
    const ballTeam = nearestPlayerTeam(players, ballPitch)

    // possession: increment whichever team has the ball nearest
    if (ballTeam === 0) a.possT1 += 1
    else if (ballTeam === 1) a.possT2 += 1
    // pass: team changed
    if (ballTeam != null && a.lastTeam != null && ballTeam !== a.lastTeam) {
      if (a.lastTeam === 0) a.passesT1 += 1
      else a.passesT2 += 1
      a.recentEvents.unshift({ t: d.idx, kind: 'Poss.', text: `Possession change — ${ballTeam === 0 ? 'T1' : 'T2'} gains` })
    }
    a.lastTeam = ballTeam

    // territory: per-team player count in own half (frame-level %)
    const t1InOwn = players.filter((p) => p.team === 0 && p.pitch[0] < 52.5).length
    const t1Count = players.filter((p) => p.team === 0).length
    const t2InOwn = players.filter((p) => p.team === 1 && p.pitch[0] > 52.5).length
    const t2Count = players.filter((p) => p.team === 1).length
    if (t1Count) a.territoryT1 += t1InOwn / t1Count
    if (t2Count) a.territoryT2 += t2InOwn / t2Count

    // distance: per-player displacement vs last history entry
    if (st.history.length) {
      const last = st.history[st.history.length - 1]
      const byId = new Map((last.players || []).map((p) => [p.id, p.pitch]))
      for (const p of players) {
        const prev = byId.get(p.id)
        if (!prev) continue
        const dM = distM(prev, p.pitch)
        const speed = dM * FPS * 3.6 // m/frame -> m/s -> km/h
        if (p.team === 0) a.distanceT1 += dM
        else a.distanceT2 += dM
        if (speed > 22) {
          if (p.team === 0) a.sprintFramesT1 += 1
          else a.sprintFramesT2 += 1
        }
      }
    }

    // shots: ball in attacking third; reset after ball leaves for >1s
    if (ballPitch) {
      if (inAttackThird(ballPitch, 0)) a.shotsT1 += 1
      if (inAttackThird(ballPitch, 1)) a.shotsT2 += 1
      if (inBox(ballPitch, 0)) a.ballInBoxT1 += 1
      if (inBox(ballPitch, 1)) a.ballInBoxT2 += 1
    }

    if (a.recentEvents.length > 6) a.recentEvents.length = 6
  }

  function load() {
    if (frameRef.current) frameRef.current.src = apiUrl(`/api/frame/${st.seq}/${st.idx}`)
    drawOverlay()
    fetch(apiUrl(`/api/process/${st.seq}/${st.idx}`))
      .then((r) => r.json())
      .then((d) => {
        if (!alive.current) return
        if (d.error) return
        const last = st.history.length ? st.history[st.history.length - 1] : null
        const lastPlayers = last ? last.players : null
        const projected = (d.players || []).map((p) => ({
          id: p.id,
          team: p.team,
          pitch: p.pitch,
          conf: p.conf,
          coasting: p.coasting,
        }))
        const projectedBall = d.ball ? d.ball.pitch : null
        st.pending = d
        st.history.push({
          idx: d.idx,
          ballPitch: projectedBall,
          players: lastPlayers || projected,
        })
        if (st.history.length > 120) st.history.shift()
        updateAnalytics(d)
        render()
        drawOverlay()
        forceTick((n) => n + 1)
      })
      .catch(() => {})
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
  function onPrev() { if (st.idx > 1) { st.idx--; setIdx(st.idx); load() } }
  function onNext() { if (st.idx < TOTAL_FRAMES) { st.idx++; setIdx(st.idx); load() } }
  function onSlider(e) { st.idx = +e.target.value; setIdx(st.idx); load() }
  function onSeqChange(e) {
    st.seq = e.target.value
    st.idx = 1; setIdx(1)
    st.history.length = 0
    Object.assign(st.analytics, {
      possT1: 0, possT2: 0, lastTeam: null, distanceT1: 0, distanceT2: 0,
      sprintFramesT1: 0, sprintFramesT2: 0, shotsT1: 0, shotsT2: 0,
      passesT1: 0, passesT2: 0, territoryT1: 0, territoryT2: 0,
      ballInBoxT1: 0, ballInBoxT2: 0, recentEvents: [],
    })
    load()
  }

  useEffect(() => {
    alive.current = true
    fetch(apiUrl('/api/sequences'))
      .then((r) => r.json())
      .then((s) => {
        if (!alive.current) return
        st.seqOptions = s
        st.seq = s[0] || SEQ
        if (seqSelRef.current) seqSelRef.current.innerHTML = s.map((x) => `<option>${x}</option>`).join('')
        st.idx = 1; setIdx(1)
        load()
      })
      .catch(() => { st.seq = SEQ; load() })
    return () => { alive.current = false }
  }, [])

  // ----- derived values from analytics -----
  const totalPoss = st.analytics.possT1 + st.analytics.possT2
  const t1Poss = totalPoss > 0 ? Math.round((st.analytics.possT1 / totalPoss) * 100) : 50
  const t2Poss = 100 - t1Poss

  const t1Count = st.pending ? st.pending.players.filter((p) => p.team === 0).length : 0
  const t2Count = st.pending ? st.pending.players.filter((p) => p.team === 1).length : 0
  const totalFrames = Math.max(st.analytics.territoryT1 + st.analytics.territoryT2, 1)
  const t1Terr = Math.round((st.analytics.territoryT1 / totalFrames) * 100)
  const t2Terr = Math.round((st.analytics.territoryT2 / totalFrames) * 100)

  const ballInBox = Math.max(st.analytics.ballInBoxT1, st.analytics.ballInBoxT2)
  const totalSprints = st.analytics.sprintFramesT1 + st.analytics.sprintFramesT2
  const distTotal = st.analytics.distanceT1 + st.analytics.distanceT2
  // mean m/s over the whole match so far: distance / (frames / FPS)
  const elapsedSec = Math.max(st.idx / FPS, 1)
  const meanSpeedKmh = (distTotal / 11 / elapsedSec) * 3.6
  const intensity = Math.min(99, Math.round((totalSprints / Math.max(st.idx, 1)) * 100 * 8))

  const stats = {
    shots: [st.analytics.shotsT1, st.analytics.shotsT2],
    inBox: [st.analytics.ballInBoxT1, st.analytics.ballInBoxT2],
    passes: [st.analytics.passesT1, st.analytics.passesT2],
    territory: [t1Terr, t2Terr],
    distance: [
      Math.round(st.analytics.distanceT1 / 11),
      Math.round(st.analytics.distanceT2 / 11),
    ],
  }
  const bars = [
    { label: 'ATTACK 3RD', t1: stats.shots[0], t2: stats.shots[1], max: Math.max(...stats.shots, 1) },
    { label: 'IN BOX', t1: stats.inBox[0], t2: stats.inBox[1], max: Math.max(...stats.inBox, 1) },
    { label: 'PASSES', t1: stats.passes[0], t2: stats.passes[1], max: Math.max(...stats.passes, 1) },
    { label: 'TERRITORY %', t1: stats.territory[0], t2: stats.territory[1], max: 100, suffix: '%' },
    { label: 'DISTANCE m', t1: stats.distance[0], t2: stats.distance[1], max: Math.max(...stats.distance, 1) },
  ]

  const seqLabel = st.seq || '—'
  const t1Color = st.teamColors[0] || '#4d4f8a'
  const t2Color = st.teamColors[1] || '#c0c6db'
  const minute = Math.min(90, Math.round((st.idx / TOTAL_FRAMES) * 90))

  // derived live frame metrics (last ~1s)
  const recent = st.history.slice(-Math.min(FPS, st.history.length))
  let liveSpeed = 0, n = 0
  if (recent.length > 1) {
    for (let i = 1; i < recent.length; i++) {
      const a = recent[i - 1], b = recent[i]
      if (!a.ballPitch || !b.ballPitch) continue
      liveSpeed += distM(a.ballPitch, b.ballPitch) * FPS * 3.6
      n++
    }
  }
  const ballSpeed = n ? (liveSpeed / n).toFixed(1) : '0.0'

  return (
    <div className="pipeline-screen">
      <header className="pipeline-topbar">
        <div className="pipeline-topbar-brand">
          <span className="pipeline-topbar-logo">S</span>
          <span>SPORTVIZ PRO</span>
          <span className="pipeline-topbar-crumb">/ Analytics</span>
        </div>
        <div className="pipeline-topbar-divider" />
        <div className="pill pill-live">LIVE</div>
        <div className="pipeline-topbar-right">
          <span className="pipeline-topbar-match">{seqLabel}</span>
          <span className="pipeline-topbar-min">{minute}'</span>
        </div>
      </header>

      <main className="pipeline-grid">
        {/* TOP-LEFT */}
        <section className="pipeline-video-panel">
          <div className="panel-label">
            <div className="panel-label-main">MATCH FEED</div>
            <div className="pill pill-live">LIVE</div>
          </div>
          <div className="pipeline-video-wrapper">
            <img ref={frameRef} alt="Live match feed" />
            <canvas ref={overlayRef}></canvas>
            <div className="pipeline-score-overlay">
              <span className="pipeline-score-team t1" style={{ color: t1Color }}>T1</span>
              <span className="pipeline-score-cell">{t1Count}</span>
              <span className="pipeline-score-cell">{t2Count}</span>
              <span className="pipeline-score-team t2" style={{ color: t2Color }}>T2</span>
              <span className="pipeline-score-min">{minute}'</span>
            </div>
            <div className="pipeline-venue">
              {seqLabel} · TRACKED · CALIB {st.pending?.calib_source?.toUpperCase() || '—'}
            </div>
            <div className="pipeline-half">Frame {st.idx} / {TOTAL_FRAMES}</div>
            <div className="pipeline-icons">
              <div className="pipeline-icon-btn">+</div>
              <div className="pipeline-icon-btn">−</div>
              <div className="pipeline-icon-btn">⤢</div>
            </div>
          </div>
          <div className="pipeline-event-ticker">
            {st.analytics.recentEvents.length === 0 ? (
              <div className="pipeline-event-item">
                <span className="pipeline-event-dot" />
                <span>Tracking {seqLabel} · frame {st.idx}</span>
              </div>
            ) : st.analytics.recentEvents.map((e, i) => (
              <div className="pipeline-event-item" key={i}>
                <span className="pipeline-event-dot" />
                <span className="pipeline-event-min">F{e.t}</span>
                <span>{e.kind} — {e.text}</span>
              </div>
            ))}
          </div>
          <div className="pipeline-slider-row">
            <span className="pipeline-slider-time current">{fmtTime(idx)}</span>
            <input type="range" min="1" max={TOTAL_FRAMES} value={idx} onInput={onSlider} />
            <span className="pipeline-slider-time">{fmtTime(TOTAL_FRAMES)}</span>
            <select ref={seqSelRef} onChange={onSeqChange} style={{
              background: 'var(--bg-panel)', border: '1px solid var(--border-mid)', color: 'var(--text)',
              padding: '3px 8px', fontSize: 11, fontFamily: 'Consolas, monospace', borderRadius: 3,
            }}></select>
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

        {/* TOP-RIGHT */}
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
              <input type="checkbox" defaultChecked onChange={(e) => { e.target.checked ? (st.overlayMode = overlayMode) : (st.overlayMode = 'raw'); render() }} />
              Zones
            </label>
            <label>
              <input type="checkbox" onChange={(e) => { e.target.checked ? (st.overlayMode = 'heat') : (st.overlayMode = 'raw'); setOverlayMode(st.overlayMode); render() }} />
              Heatmap
            </label>
            <label>
              <input type="checkbox" onChange={(e) => { e.target.checked ? (st.overlayMode = 'ball') : (st.overlayMode = 'raw'); setOverlayMode(st.overlayMode); render() }} />
              Ball trail
            </label>
            <label>
              <input type="checkbox" onChange={() => render()} />
              IDs
            </label>
            <label>
              <input type="checkbox" onChange={() => render()} />
              Ground Truth
            </label>
          </div>
        </section>

        {/* BOTTOM-LEFT */}
        <section className="pipeline-bl-panel">
          <div className="panel-label">
            <div className="panel-label-main">ANALYSIS OVERLAY</div>
          </div>
          <div>
            {OVERLAY_MODES.map((m) => (
              <div key={m.id} className={`overlay-row ${overlayMode === m.id ? 'active' : ''}`} onClick={() => setOverlay(m.id)}>
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
            <div className="panel-label-sub">{fmtClock(clock)}</div>
          </div>
          <div className="metric-grid">
            <MetricCard label="BALL SPEED" value={ballSpeed} unit="km/h" />
            <MetricCard label="PLAYERS" value={t1Count + t2Count} unit="trk" />
            <MetricCard label="SPRINTS" value={totalSprints} unit="frm" />
            <MetricCard label="INTENSITY" value={intensity} unit="%" />
          </div>
        </section>

        {/* BOTTOM-RIGHT */}
        <section className="pipeline-br-panel">
          <div className="panel-label">
            <div className="panel-label-main">MATCH STATS</div>
            <div className="panel-label-sub">· TRACKED</div>
            <div style={{ marginLeft: 'auto' }}>
              <span className="stats-time">{fmtClock(clock)}</span>
            </div>
          </div>
          <div className="score-row">
            <div className="score-team t1">
              <span className="score-dot t1" style={{ background: t1Color, boxShadow: `0 0 8px ${t1Color}` }} />
              <span>Team 1 · {t1Count} on</span>
            </div>
            <div className="score-numbers">
              <span className="score-num t1" style={{ color: t1Color }}>{t1Count}</span>
              <span className="score-dash">·</span>
              <span className="score-num t2" style={{ color: t2Color }}>{t2Count}</span>
            </div>
            <div className="score-team t2">
              <span>Team 2 · {t2Count} on</span>
              <span className="score-dot t2" style={{ background: t2Color, boxShadow: `0 0 8px ${t2Color}` }} />
            </div>
          </div>
          <div className="poss-row">
            <div className="poss-left">
              <div className="poss-pct" style={{ color: t1Color }}>{t1Poss}%</div>
              <div className="poss-label">POSS</div>
            </div>
            <PossessionDonut p1={t1Poss} p2={t2Poss} t1={t1Color} t2={t2Color} />
            <div className="poss-right">
              <div className="poss-pct" style={{ color: t2Color }}>{t2Poss}%</div>
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
