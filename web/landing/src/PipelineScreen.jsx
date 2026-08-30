import { useEffect, useRef, useState } from 'react'
import './PipelineScreen.css'
import { apiUrl } from './config.js'

const TOTAL_FRAMES = 750
const FPS = 25
const PITCH_W = 105
const PITCH_H = 68

const OVERLAY_MODES = [
  { id: 'raw', title: 'Raw View', sub: 'Live tracked player positions' },
  { id: 'heat', title: 'Heatmap', sub: 'Ball location density over time' },
  { id: 'ball', title: 'Ball Tracking', sub: 'Trajectory + team control zones' },
]

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmtTime(idx) {
  const s = Math.floor((idx || 0) / FPS)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function distM(a, b) {
  if (!a || !b) return 0
  return Math.hypot((a[0] - b[0]) || 0, (a[1] - b[1]) || 0)
}

function nearestTeam(players, ballPitch) {
  if (!ballPitch || !players.length) return null
  let best = null, bestD = Infinity
  for (const p of players) {
    if (!p.pitch) continue
    const d = distM(p.pitch, ballPitch)
    if (d < bestD) { bestD = d; best = p }
  }
  return best && bestD < 4 ? best.team : null
}

function inField(p) {
  return p && p[0] > -2 && p[0] < 107 && p[1] > -2 && p[1] < 70
}

function hexA(hex, a) {
  if (!hex || !hex.startsWith('#')) return `rgba(255,255,255,${a})`
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

function drawPitch(ctx, W, H) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height
  const m = 6
  const s = Math.min((cw - 2 * m) / W, (ch - 2 * m) / H)
  const X = (x) => m + x * s
  const Y = (y) => m + y * s
  ctx.clearRect(0, 0, cw, ch)

  const stripes = 10
  const sw = (W * s) / stripes
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#1f6b3a' : '#195e30'
    ctx.fillRect(X(i * (W / stripes)), Y(0), sw + 1, H * s)
  }
  const grad = ctx.createRadialGradient(X(W / 2), Y(H / 2), 10, X(W / 2), Y(H / 2), W * s * 0.7)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = grad
  ctx.fillRect(X(0), Y(0), W * s, H * s)

  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(X(0), Y(0), W * s, H * s)
  ctx.beginPath()
  ctx.moveTo(X(W / 2), Y(0)); ctx.lineTo(X(W / 2), Y(H)); ctx.stroke()
  ctx.beginPath()
  ctx.arc(X(W / 2), Y(H / 2), 9.15 * s, 0, 2 * Math.PI); ctx.stroke()
  ctx.beginPath()
  ctx.arc(X(W / 2), Y(H / 2), 0.6 * s, 0, 2 * Math.PI)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill()

  for (const side of [[0, 1], [W, -1]]) {
    const [gx, dir] = side
    ctx.strokeRect(X(Math.min(gx, gx + 16.5 * dir)), Y(13.84), 16.5 * s, 40.32 * s)
    ctx.strokeRect(X(Math.min(gx, gx + 5.5 * dir)), Y(24.84), 5.5 * s, 18.32 * s)
    ctx.strokeRect(X(Math.min(gx, gx + 2 * dir)), Y(34 - 3.66), 2 * s, 7.32 * s)
    const penSpot = dir === 1 ? [11, 34] : [94, 34]
    ctx.beginPath(); ctx.arc(X(penSpot[0]), Y(penSpot[1]), 0.6 * s, 0, 2 * Math.PI); ctx.fill()
    const arcX = dir === 1 ? 11 : 94
    const arcStart = dir === 1 ? 0.55 : 2.55
    const arcEnd = dir === 1 ? 5.75 : 3.75
    ctx.beginPath(); ctx.arc(X(arcX), Y(34), 8 * s, arcStart * Math.PI, arcEnd * Math.PI); ctx.stroke()
  }
  return { X, Y, s }
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

function ClipCard({ clip, active, onClick }) {
  const status = clip.status
  const pct = clip.total_frames > 0 ? Math.round((clip.cached_frames / clip.total_frames) * 100) : 0
  const pillClass =
    status === 'ready' ? 'cl-status-ready' :
    status === 'partial' ? 'cl-status-partial' :
    status === 'loading' ? 'cl-status-loading' :
    status === 'error' ? 'cl-status-error' : 'cl-status-cold'
  const label =
    status === 'ready' ? 'READY' :
    status === 'partial' ? 'PARTIAL' :
    status === 'loading' ? 'WARMING' :
    status === 'error' ? 'ERROR' : 'COLD'
  return (
    <div className={`cl-card${active ? ' active' : ''}`} onClick={() => onClick(clip)}>
      <div className="cl-thumb">
        <img src={apiUrl(`/api/thumbnail/${clip.seq}`)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
      </div>
      <div className="cl-info">
        <div className="cl-seq">{clip.seq}</div>
        <div className="cl-row">
          <span className={`cl-status-pill ${pillClass}`}>{label}</span>
          <span>{pct}% · {clip.cached_frames}/{clip.total_frames || '?'}</span>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ label, value, unit }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div>
        <span className="metric-value">{value}</span>
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
    </div>
  )
}

function BarRow({ row }) {
  const max = row.max || 1
  const p1 = Math.min(100, (row.t1 / max) * 100)
  const p2 = Math.min(100, (row.t2 / max) * 100)
  const fmt = (v) => (row.dec != null ? Number(v).toFixed(row.dec) : v) + (row.suffix || '')
  return (
    <div className="bar-row">
      <span className="bar-val l">{fmt(row.t1)}</span>
      <div className="bar-track">
        <div className="fill l" style={{ width: `${p1}%` }} />
        <div className="fill r" style={{ width: `${p2}%` }} />
      </div>
      <span className="bar-val r">{fmt(row.t2)}</span>
    </div>
  )
}

function PossessionDonut({ p1, p2, c1, c2 }) {
  const R = 20
  const C = 2 * Math.PI * R
  const t1Len = C * (p1 / 100)
  return (
    <div className="poss-donut">
      <svg viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={R} fill="none" stroke="var(--border-mid)" strokeWidth="5" />
        <circle cx="26" cy="26" r={R} fill="none" stroke={c1} strokeWidth="5"
          strokeDasharray={`${t1Len} ${C}`} strokeLinecap="butt" />
        <circle cx="26" cy="26" r={R} fill="none" stroke={c2} strokeWidth="5"
          strokeDasharray={`${C * (p2 / 100)} ${C}`} strokeDashoffset={-t1Len} strokeLinecap="butt" />
      </svg>
      <div className="poss-donut-center" />
    </div>
  )
}

function PipelineScreen() {
  const st = useRef({
    seq: null,
    idx: 1,
    playing: false,
    busy: false,
    pending: null,
    teamColors: ['#4d4f8a', '#c0c6db'],
    overlayMode: 'raw',
    history: [],
    analytics: {
      possT1: 0, possT2: 0, lastTeam: null,
      distanceT1: 0, distanceT2: 0,
      sprintFramesT1: 0, sprintFramesT2: 0,
      shotsT1: 0, shotsT2: 0,
      passesT1: 0, passesT2: 0,
      territoryT1: 0, territoryT2: 0,
      ballInBoxT1: 0, ballInBoxT2: 0,
      events: [],
    },
    fetchError: null,
    lastSeqAt: null,
    // Per-frame buffer: pre-fetch a window of frames around the playhead so
    // playback at 5-15 fps is steady instead of stuttery. The browser makes
    // ~6 concurrent requests; with 220ms backend latency a buffer of 8 gives
    // ~1.6s of smooth playback. Each entry: { idx, data, srcLoaded }.
    frameBuffer: new Map(),
    bufferLow: 0,
    bufferHigh: 0,
    // Request rate control: the browser caps at 6 concurrent connections
    // per origin, and emitting 30 req/sec during auto-play saturated the
    // queue. Track in-flight fetches and drop new ones past 4 to leave
    // headroom for prefetch.
    inFlight: 0,
    requestSeq: 0,
    // Rolling latency tracker for adaptive tick interval
    latencyEma: 100,
  }).current

  const [clips, setClips] = useState([])
  const [activeSeq, setActiveSeq] = useState(null)
  const [clipLoadState, setClipLoadState] = useState('idle') // idle | warming | ready | error
  const [idx, setIdx] = useState(1)
  const [overlayMode, setOverlayMode] = useState('raw')
  const [clock, setClock] = useState(() => new Date())
  const [playing, setPlaying] = useState(false)
  const [diag, setDiag] = useState({ kpts: '—', calib: '—', players: 0, hq: 0, ball: '—' })
  const [backendUp, setBackendUp] = useState(true)
  const [bufferPct, setBufferPct] = useState(0)
  const [bufferedFrames, setBufferedFrames] = useState(0)
  const [precompute, setPrecompute] = useState({ state: 'idle', done: 0, total: 0 })
  const [showGT, setShowGT] = useState(true)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showIds, setShowIds] = useState(true)

  const frameRef = useRef(null)
  const overlayRef = useRef(null)
  const pitchRef = useRef(null)
  const playBtnRef = useRef(null)
  const speedSelRef = useRef(null)
  const alive = useRef(true)
  const clipSeqRef = useRef(null)

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    alive.current = true
    refreshClips()
    return () => { alive.current = false }
  }, [])

  useEffect(() => { if (activeSeq) renderPitch() }, [activeSeq, overlayMode, idx])

  async function refreshClips() {
    try {
      const r = await fetch(apiUrl('/api/clips'))
      if (!r.ok) throw new Error('status ' + r.status)
      const data = await r.json()
      if (!alive.current) return
      setClips(data)
      setBackendUp(true)
      if (!activeSeq && data.length > 0) {
        // Prefer SNGS-027 (the reference match) and any clip already cached
        const preferred =
          data.find((c) => c.seq === 'SNGS-027') ||
          data.find((c) => c.status === 'ready') ||
          data[0]
        if (preferred) loadClip(preferred)
      }
    } catch (e) {
      if (!alive.current) return
      setBackendUp(false)
    }
  }

  async function loadClip(clip) {
    if (clipLoadState === 'warming') return
    setActiveSeq(clip.seq)
    st.seq = clip.seq
    clipSeqRef.current = clip.seq
    st.idx = 1; setIdx(1)
    st.history.length = 0
    Object.assign(st.analytics, {
      possT1: 0, possT2: 0, lastTeam: null,
      distanceT1: 0, distanceT2: 0,
      sprintFramesT1: 0, sprintFramesT2: 0,
      shotsT1: 0, shotsT2: 0,
      passesT1: 0, passesT2: 0,
      territoryT1: 0, territoryT2: 0,
      ballInBoxT1: 0, ballInBoxT2: 0,
      events: [],
    })
    st.fetchError = null
    resetBuffer()

    if (clip.status === 'ready') {
      setClipLoadState('ready')
      loadFrame(1)
      autoStartPlayback()
      return
    }
    setClipLoadState('warming')
    try {
      const r = await fetch(apiUrl(`/api/warm_clip/${clip.seq}`), { method: 'POST' })
      if (!r.ok) throw new Error('warm failed')
      if (!alive.current) return
      setClipLoadState('ready')
      setClips((prev) => prev.map((c) => c.seq === clip.seq ? { ...c, status: 'ready', cached_frames: clip.total_frames } : c))
      loadFrame(1)
      autoStartPlayback()
    } catch (e) {
      if (!alive.current) return
      setClipLoadState('error')
    }
  }

  function kickoffFullPrefetch() {
    // Once a clip is warm, fire 4 concurrent streams that each grab every
    // 4th frame in batches. With 220ms per request, 4 streams fill the
    // 750-frame buffer in ~40s. Playback stays smooth because prefetchAhead
    // is already pulling the next 10 frames around the playhead.
    if (!st.seq) return
    const streams = 4
    const total = TOTAL_FRAMES
    for (let s = 0; s < streams; s++) {
      const start = s + 1
      for (let idx = start; idx <= total; idx += streams) {
        const captured = idx
        if (st.frameBuffer.has(captured)) continue
        const slot = {}
        st.frameBuffer.set(captured, slot)
        // small delay so we don't open 750 sockets at once
        const delay = (s * 60) + Math.floor((idx - start) / streams) * 8
        setTimeout(() => {
          if (!alive.current || st.seq !== clipSeqRef.current) return
          fetch(apiUrl(`/api/process/${st.seq}/${captured}`))
            .then((r) => r.json())
            .then((d) => {
              if (!alive.current || d.error) return
              const slot = st.frameBuffer.get(captured) || {}
              slot.data = d
              st.frameBuffer.set(captured, slot)
              refreshBufferUi()
            })
            .catch(() => {})
        }, delay)
      }
    }
  }

  function autoStartPlayback() {
    // Give the first frame a moment to render, then start ticking so the
    // user immediately sees the clip animate — no need to find the Play
    // button to verify the rendering is correct.
    setTimeout(() => {
      if (!alive.current || st.playing) return
      st.playing = true
      setPlaying(true)
      tick()
    }, 600)
  }

  function loadFrame(targetIdx) {
    if (!st.seq) return
    st.requestSeq = (st.requestSeq || 0) + 1
    const myReq = st.requestSeq
    // Take from buffer if we already have this frame, otherwise fetch it now.
    const cached = st.frameBuffer.get(targetIdx)
    if (cached) {
      if (cached.data) applyFrameData(cached.data)
      if (cached.src && !st.playing) frameRef.current.src = cached.src
      return
    }
    // Don't fetch the JPEG if we're auto-playing and a recent frame is already
    // shown — the <img> animation is smoother when the browser just keeps the
    // previous frame visible while process data updates. The user only needs
    // a fresh JPEG on manual scrub or play/pause boundaries.
    if (!st.playing) {
      const src = apiUrl(`/api/frame/${st.seq}/${targetIdx}?t=${Date.now()}_${targetIdx}`)
      frameRef.current.src = src
    }
    // Backpressure: if we already have 4+ requests in flight, skip this frame.
    // The tick loop will catch up on the next pass instead of queueing.
    if (st.inFlight >= 4) return
    st.inFlight++
    const t0 = performance.now()
    fetch(apiUrl(`/api/process/${st.seq}/${targetIdx}`))
      .then((r) => r.json())
      .then((d) => {
        st.inFlight = Math.max(0, st.inFlight - 1)
        const dt = performance.now() - t0
        st.latencyEma = st.latencyEma ? 0.7 * st.latencyEma + 0.3 * dt : dt
        if (!alive.current || myReq !== st.requestSeq) return
        if (d.error) return
        const slot = st.frameBuffer.get(targetIdx) || {}
        slot.data = d
        st.frameBuffer.set(targetIdx, slot)
        if (targetIdx === st.idx) applyFrameData(d)
      })
      .catch(() => { st.inFlight = Math.max(0, st.inFlight - 1) })
    if (!st.playing) prefetchAhead(targetIdx)
  }

  function applyFrameData(d) {
    if (!alive.current) return
    st.pending = d
    const last = st.history[st.history.length - 1]
    const lastPlayers = last ? last.players : null
    st.history.push({
      idx: d.idx,
      ballPitch: d.ball ? d.ball.pitch : null,
      players: lastPlayers || d.players,
    })
    if (st.history.length > 120) st.history.shift()
    updateAnalytics(d)
    setDiag({
      kpts: d.kpts ? `${d.kpts.visible}/${d.kpts.total}` : '—',
      calib: d.calib_source || '—',
      players: d.players.length,
      hq: Math.round((d.h_quality || 0) * 100),
      ball: d.ball ? `${Math.round((d.ball.conf || 0) * 100)}%` : '—',
    })
    renderPitch()
    drawVideoOverlay()
    refreshBufferUi()
  }

  function refreshBufferUi() {
    const ready = [...st.frameBuffer.values()].filter((s) => s && s.data).length
    setBufferedFrames(ready)
    setBufferPct(ready / Math.max(TOTAL_FRAMES, 1))
  }

  function prefetchAhead(currentIdx) {
    if (!st.seq) return
    // Pull only the next 3 frames into the buffer. Aggressive prefetching
    // (10+) saturates the 4-thread gunicorn worker and causes the user's
    // actual playback requests to queue behind 750 background fetches,
    // pushing per-frame latency from 90ms to 4000ms.
    const ahead = 3
    const behind = 8
    for (let off = 1; off <= ahead; off++) {
      const idx = currentIdx + off
      if (idx > TOTAL_FRAMES) break
      if (st.frameBuffer.has(idx)) continue
      const slot = {}
      st.frameBuffer.set(idx, slot)
      fetch(apiUrl(`/api/process/${st.seq}/${idx}`))
        .then((r) => r.json())
        .then((d) => {
          if (!alive.current || d.error) return
          const s = st.frameBuffer.get(idx) || {}
          s.data = d
          st.frameBuffer.set(idx, s)
          refreshBufferUi()
        })
        .catch(() => {})
    }
    const nextSrc = currentIdx + 1
    if (nextSrc <= TOTAL_FRAMES) {
      const nextSlot = st.frameBuffer.get(nextSrc) || {}
      if (!nextSlot.src) {
        const src = apiUrl(`/api/frame/${st.seq}/${nextSrc}?t=${Date.now()}_${nextSrc}`)
        nextSlot.src = src
        st.frameBuffer.set(nextSrc, nextSlot)
      }
    }
    const minKeep = Math.max(1, currentIdx - behind)
    for (const k of st.frameBuffer.keys()) {
      if (k < minKeep) st.frameBuffer.delete(k)
    }
  }

  function resetBuffer() {
    st.frameBuffer.clear()
  }

  function updateAnalytics(d) {
    const a = st.analytics
    const players = (d.players || []).filter((p) => p.pitch && inField(p.pitch))
    const ballPitch = d.ball && d.ball.pitch ? d.ball.pitch : null
    const team = nearestTeam(players, ballPitch)
    if (team === 0) a.possT1 += 1
    else if (team === 1) a.possT2 += 1
    if (team != null && a.lastTeam != null && team !== a.lastTeam) {
      if (a.lastTeam === 0) a.passesT1 += 1; else a.passesT2 += 1
      a.events.unshift({ idx: d.idx, kind: 'POSS', text: `Possession change — Team ${team === 0 ? 1 : 2}` })
    }
    a.lastTeam = team

    if (ballPitch) {
      if (ballPitch[0] < 16.5) a.shotsT1 += 1
      if (ballPitch[0] > 88.5) a.shotsT2 += 1
      if (ballPitch[0] < 16.5 && ballPitch[1] > 13.84 && ballPitch[1] < 54.16) a.ballInBoxT1 += 1
      if (ballPitch[0] > 88.5 && ballPitch[1] > 13.84 && ballPitch[1] < 54.16) a.ballInBoxT2 += 1
    }

    if (st.history.length > 1) {
      const last = st.history[st.history.length - 2]
      const byId = new Map((last.players || []).map((p) => [p.id, p.pitch]))
      for (const p of players) {
        const prev = byId.get(p.id)
        if (!prev) continue
        const dM = distM(prev, p.pitch)
        if (p.team === 0) a.distanceT1 += dM; else a.distanceT2 += dM
        if (dM * FPS * 3.6 > 22) {
          if (p.team === 0) a.sprintFramesT1 += 1; else a.sprintFramesT2 += 1
        }
      }
    }
    const t1c = players.filter((p) => p.team === 0).length
    const t2c = players.filter((p) => p.team === 1).length
    if (t1c) a.territoryT1 += players.filter((p) => p.team === 0 && p.pitch[0] < 52.5).length / t1c
    if (t2c) a.territoryT2 += players.filter((p) => p.team === 1 && p.pitch[0] > 52.5).length / t2c
    if (a.events.length > 8) a.events.length = 8
  }

  function drawVideoOverlay() {
    const img = frameRef.current
    const cv = overlayRef.current
    if (!img || !cv) return
    if (!img.naturalWidth) { requestAnimationFrame(drawVideoOverlay); return }
    const scale = img.clientWidth / img.naturalWidth
    cv.width = img.clientWidth
    cv.height = img.clientHeight
    cv.style.left = img.offsetLeft + 'px'
    cv.style.top = img.offsetTop + 'px'
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, cv.width, cv.height)
    const d = st.pending
    if (!d) return

    // Pitch lines projected back into the image (magenta, dashed)
    if (showOverlay && d.overlay_lines) {
      ctx.strokeStyle = 'rgba(255, 45, 106, 0.85)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      for (const line of d.overlay_lines) {
        ctx.beginPath()
        ctx.moveTo(line[0][0] * scale, line[0][1] * scale)
        ctx.lineTo(line[1][0] * scale, line[1][1] * scale)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Team-colored foot markers at the image-space positions of detected players
    for (const p of d.players || []) {
      if (!p.img) continue
      const t = Math.min(1, Math.max(0, p.img[1] / img.naturalHeight))
      const rx = Math.max(6, img.clientWidth * (0.008 + 0.014 * t))
      const x = p.img[0] * scale, y = p.img[1] * scale
      ctx.globalAlpha = p.coasting ? 0.45 : 1.0
      const c = p.team === 0 ? ((d.team_colors && d.team_colors[0]) || st.teamColors[0])
        : p.team === 1 ? ((d.team_colors && d.team_colors[1]) || st.teamColors[1])
        : '#ffffff'
      ctx.strokeStyle = c
      ctx.lineWidth = Math.max(2, rx * 0.16)
      ctx.beginPath()
      ctx.ellipse(x, y, rx, rx * 0.38, 0, 0, 2 * Math.PI)
      ctx.stroke()
    }
    ctx.globalAlpha = 1.0

    // Ball marker (orange ring on the image)
    if (d.ball && d.ball.img) {
      const t = Math.min(1, Math.max(0, d.ball.img[1] / img.naturalHeight))
      const r = Math.max(5, img.clientWidth * (0.005 + 0.007 * t))
      ctx.globalAlpha = d.ball.coasting ? 0.45 : 1.0
      ctx.strokeStyle = '#ffb020'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(d.ball.img[0] * scale, d.ball.img[1] * scale, r, 0, 2 * Math.PI)
      ctx.stroke()
      ctx.globalAlpha = 1.0
    }
  }

  function renderPitch() {
    const c = pitchRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    const { X, Y } = drawPitch(ctx, PITCH_W, PITCH_H)
    const d = st.pending
    if (!d) return
    const detectedPlayers = (d.players || []).filter((p) => p.pitch && inField(p.pitch))
    const t1Color = (d.team_colors && d.team_colors[0]) || st.teamColors[0]
    const t2Color = (d.team_colors && d.team_colors[1]) || st.teamColors[1]
    st.teamColors = [t1Color, t2Color]

    // Detect a degenerate projection: detected players clustered in a small
    // pitch area but their image-space positions spanned a wide range. When
    // this happens we keep rendering the detection but desaturate it so the
    // GT baseline (always-on) reads as the truth.
    let degenerate = false
    if (detectedPlayers.length >= 4) {
      const xs = detectedPlayers.map((p) => p.pitch[0])
      const ys = detectedPlayers.map((p) => p.pitch[1])
      if (Math.max(...xs) - Math.min(...xs) < 15 && Math.max(...ys) - Math.min(...ys) < 20) {
        degenerate = true
      }
    }

    // GT baseline (always on, matches the local test bench behavior).
    // Renders the actual SoccerNet ground-truth positions as small white
    // hollow rings so the user has a truthful reference even when the
    // model projection is degenerate. Suppressed when the user toggles it off.
    if (showGT) {
      const gt = (d.gt && d.gt.players_pitch) || []
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      for (const p of gt) {
        if (!inField(p)) continue
        const x = X(p[0]), y = Y(p[1])
        ctx.beginPath()
        ctx.arc(x, y, 5, 0, 2 * Math.PI)
        ctx.stroke()
      }
      // GT ball as orange hollow ring
      const gtBall = (d.gt && d.gt.ball_pitch && d.gt.ball_pitch[0]) || null
      if (gtBall && inField(gtBall)) {
        ctx.strokeStyle = 'rgba(255,176,32,0.7)'
        ctx.beginPath()
        ctx.arc(X(gtBall[0]), Y(gtBall[1]), 4, 0, 2 * Math.PI)
        ctx.stroke()
      }
    }

    // Heatmap + ball trail overlays (only when in heat/ball mode)
    if (st.overlayMode === 'heat' || st.overlayMode === 'ball') {
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
        if (!started) { ctx.moveTo(p[0], p[1]); started = true } else ctx.lineTo(p[0], p[1])
      }
      ctx.stroke()
      ctx.restore()
    }

    // Team control zones from detected players (only render when not degenerate;
    // hulls of clustered detections make a misleading tiny blob)
    if (!degenerate) {
      const t1Pts = detectedPlayers.filter((p) => p.team === 0).map((p) => [X(p.pitch[0]), Y(p.pitch[1])])
      const t2Pts = detectedPlayers.filter((p) => p.team === 1).map((p) => [X(p.pitch[0]), Y(p.pitch[1])])
      if (t1Pts.length >= 3) {
        const h1 = hull(t1Pts)
        ctx.beginPath(); ctx.moveTo(h1[0][0], h1[0][1])
        for (let i = 1; i < h1.length; i++) ctx.lineTo(h1[i][0], h1[i][1])
        ctx.closePath(); ctx.fillStyle = hexA(t1Color, 0.18); ctx.fill()
      }
      if (t2Pts.length >= 3) {
        const h2 = hull(t2Pts)
        ctx.beginPath(); ctx.moveTo(h2[0][0], h2[0][1])
        for (let i = 1; i < h2.length; i++) ctx.lineTo(h2[i][0], h2[i][1])
        ctx.closePath(); ctx.fillStyle = hexA(t2Color, 0.18); ctx.fill()
      }
    }

    // Detected players: filled team-colored circles (or desaturated if degenerate)
    for (const p of detectedPlayers) {
      const c = p.team === 0 ? t1Color : (p.team === 1 ? t2Color : '#9aa6b8')
      const r = p.coasting ? 7 : 9
      ctx.globalAlpha = degenerate ? 0.35 : p.coasting ? 0.55 : 1
      if (showIds) {
        drawPlayer(ctx, X(p.pitch[0]), Y(p.pitch[1]), p.id != null ? p.id : '?', c, r)
      } else {
        ctx.beginPath()
        ctx.arc(X(p.pitch[0]) + 1, Y(p.pitch[1]) + 1, r, 0, 2 * Math.PI)
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill()
        ctx.beginPath()
        ctx.arc(X(p.pitch[0]), Y(p.pitch[1]), r, 0, 2 * Math.PI)
        ctx.fillStyle = c; ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // Ball: prefer the model detection; if absent, use the GT ball ring
    let ballPitch = d.ball && d.ball.pitch && inField(d.ball.pitch) ? d.ball.pitch : null
    if (ballPitch) {
      ctx.globalAlpha = degenerate ? 0.4 : 1
      drawBall(ctx, X(ballPitch[0]), Y(ballPitch[1]))
      ctx.globalAlpha = 1
    } else if (!showGT) {
      // Only show the missing-ball marker when GT is also off (otherwise the
      // orange GT ring already shows the ball location)
      const cx = X(52.5), cy = Y(34)
      ctx.beginPath()
      ctx.arc(cx, cy, 8, 0, 2 * Math.PI)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.font = '600 11px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('?', cx, cy)
    }
    if (degenerate) {
      // Frame index badge so the user can correlate pitch with slider
      ctx.fillStyle = 'rgba(255, 45, 106, 0.85)'
      ctx.fillRect(8, 8, 110, 18)
      ctx.fillStyle = '#fff'
      ctx.font = '600 10px Consolas, monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`F${String(d.idx).padStart(3, '0')} DEGENERATE`, 14, 17)
    } else if (d.idx) {
      ctx.fillStyle = 'rgba(6, 10, 20, 0.7)'
      ctx.fillRect(8, 8, 64, 18)
      ctx.fillStyle = '#00ff88'
      ctx.font = '600 10px Consolas, monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`F${String(d.idx).padStart(3, '0')}`, 14, 17)
    }
  }

  function tick() {
    if (!st.playing) return
    if (st.idx >= TOTAL_FRAMES) {
      st.playing = false; setPlaying(false)
      return
    }
    st.idx++; setIdx(st.idx)
    loadFrame(st.idx)
    // Adaptive interval: scale the wall-clock target to measured server
    // latency. On a fast LAN we render at 5 fps (200ms); on a slow mobile
    // network the EMA will push the interval up to 500ms so the queue
    // stays empty and per-frame latency matches the actual server time.
    const base = +(speedSelRef.current?.value || 200)
    const adaptive = Math.max(base, Math.round(st.latencyEma * 1.4))
    setTimeout(() => alive.current && tick(), adaptive)
  }

  function onPlay() {
    if (clipLoadState !== 'ready') return
    st.playing = !st.playing
    setPlaying(st.playing)
    if (st.playing) tick()
  }
  function onPrev() { if (st.idx > 1) { st.idx--; setIdx(st.idx); loadFrame(st.idx) } }
  function onNext() { if (st.idx < TOTAL_FRAMES) { st.idx++; setIdx(st.idx); loadFrame(st.idx) } }
  function onSlider(e) { st.idx = +e.target.value; setIdx(st.idx); loadFrame(st.idx) }

  function setOverlay(id) {
    st.overlayMode = id
    setOverlayMode(id)
  }

  function startPrecompute() {
    if (!st.seq || precompute.state !== 'idle') return
    setPrecompute({ state: 'queued', done: 0, total: 0 })
    fetch(apiUrl(`/api/precompute/${st.seq}`), { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (d.already_done) {
          setPrecompute({ state: 'done', done: 0, total: 0 })
          setTimeout(() => setPrecompute({ state: 'idle', done: 0, total: 0 }), 2000)
          return
        }
        pollPrecompute()
      })
      .catch(() => setPrecompute({ state: 'error', done: 0, total: 0 }))
  }

  function pollPrecompute() {
    if (!st.seq) return
    fetch(apiUrl(`/api/progress/${st.seq}`))
      .then((r) => r.json())
      .then((p) => {
        if (!alive.current) return
        if (p.total > 0 && !p.finished) {
          setPrecompute({ state: 'running', done: p.done, total: p.total })
          setTimeout(() => alive.current && pollPrecompute(), 3000)
        } else if (p.finished) {
          setPrecompute({ state: 'done', done: p.total, total: p.total })
          setClips((prev) => prev.map((c) => c.seq === st.seq ? { ...c, status: 'ready', cached_frames: p.total } : c))
          resetBuffer()
          loadFrame(st.idx)
          setTimeout(() => setPrecompute({ state: 'idle', done: 0, total: 0 }), 2000)
        } else {
          setPrecompute({ state: 'idle', done: 0, total: 0 })
        }
      })
      .catch(() => setTimeout(() => alive.current && pollPrecompute(), 5000))
  }

  // ---- derived UI values ----
  const totalPoss = st.analytics.possT1 + st.analytics.possT2
  const t1Poss = totalPoss > 0 ? Math.round((st.analytics.possT1 / totalPoss) * 100) : 50
  const t2Poss = 100 - t1Poss
  const t1Count = st.pending ? st.pending.players.filter((p) => p.team === 0).length : 0
  const t2Count = st.pending ? st.pending.players.filter((p) => p.team === 1).length : 0
  const t1Color = (st.pending && st.pending.team_colors && st.pending.team_colors[0]) || st.teamColors[0]
  const t2Color = (st.pending && st.pending.team_colors && st.pending.team_colors[1]) || st.teamColors[1]

  // Degenerate projection check: when 6+ players are clustered into a tiny
  // pitch area but their pixel positions spanned a wide range, the
  // homography fit is bad even if the model claimed calib=model. The pitch
  // then shows GT fallback instead, and the header pill flips red.
  const ps = st.pending && st.pending.players
  let isDegenerate = false
  if (ps && ps.length >= 6) {
    const xs = ps.map((p) => p.pitch[0])
    const ys = ps.map((p) => p.pitch[1])
    if (Math.max(...xs) - Math.min(...xs) < 15 && Math.max(...ys) - Math.min(...ys) < 20) {
      isDegenerate = true
    }
  }
  const usingGT = isDegenerate || (st.pending && st.pending.players && st.pending.players.length === 0)

  const totalTerr = Math.max(st.analytics.territoryT1 + st.analytics.territoryT2, 1)
  const t1Terr = Math.round((st.analytics.territoryT1 / totalTerr) * 100)
  const t2Terr = Math.round((st.analytics.territoryT2 / totalTerr) * 100)
  const totalSprints = st.analytics.sprintFramesT1 + st.analytics.sprintFramesT2
  const totalShots = st.analytics.shotsT1 + st.analytics.shotsT2
  const totalInBox = st.analytics.ballInBoxT1 + st.analytics.ballInBoxT2
  const totalPasses = st.analytics.passesT1 + st.analytics.passesT2

  const bars = [
    { label: 'POSSESSION %', t1: t1Poss, t2: t2Poss, max: 100, suffix: '%' },
    { label: 'ATTACK 3RD', t1: st.analytics.shotsT1, t2: st.analytics.shotsT2, max: Math.max(totalShots, 1) },
    { label: 'IN BOX', t1: st.analytics.ballInBoxT1, t2: st.analytics.ballInBoxT2, max: Math.max(totalInBox, 1) },
    { label: 'POSS CHANGES', t1: st.analytics.passesT1, t2: st.analytics.passesT2, max: Math.max(totalPasses, 1) },
    { label: 'TERRITORY %', t1: t1Terr, t2: t2Terr, max: 100, suffix: '%' },
  ]

  const videoReady = clipLoadState === 'ready' && st.pending
  const calibPill =
    diag.calib === 'model' ? <span className="pill pill-active">CALIB OK</span> :
    diag.calib === 'held' || diag.calib === 'carried' ? <span className="pill pill-warn">CALIB {diag.calib.toUpperCase()}</span> :
    diag.calib === 'frozen' ? <span className="pill pill-info">FROZEN</span> :
    diag.calib === 'none' ? <span className="pill pill-warn">NO CALIB</span> :
    <span className="pill pill-info">WAITING</span>

  return (
    <div className="pipeline-screen">
      <header className="pipeline-topbar">
        <div className="tb-brand">
          <span className="tb-logo">S</span>
          <span>SPORTVIZ PRO</span>
          <span className="tb-crumb">/ Analytics</span>
        </div>
        <div className="tb-divider" />
        <div className="pill pill-live">LIVE</div>
        <div className="tb-spacer" />
        <div className="tb-meta">
          <span>SEQ <strong>{activeSeq || '—'}</strong></span>
          <span>FRAME <strong>{idx}/{TOTAL_FRAMES}</strong></span>
          <span>VIDEO <strong>{fmtTime(idx)}</strong></span>
        </div>
        <div className="tb-divider" />
        <div className={`tb-status ${backendUp ? '' : 'bad'}`}>
          <span className="tb-status-dot" />
          {backendUp ? 'API ONLINE' : 'API OFFLINE'}
        </div>
      </header>

      <main className="pipeline-main">
        {/* CLIP LIBRARY */}
        <aside className="clip-library">
          <div className="cl-header">
            <div className="cl-title">Clip Library</div>
            <div className="cl-sub">Select a tracked match to analyze. Cold clips warm in ~1s.</div>
          </div>
          <div className="cl-list">
            {clips.length === 0 && backendUp && (
              <div className="pitch-empty" style={{ padding: 20 }}>
                <strong>Loading clips...</strong>
                <p>Connecting to backend</p>
              </div>
            )}
            {clips.length === 0 && !backendUp && (
              <div className="pitch-empty" style={{ padding: 20 }}>
                <strong>Backend unreachable</strong>
                <p>Check the API status indicator in the top bar.</p>
              </div>
            )}
            {clips.map((c) => (
              <ClipCard key={c.seq} clip={c} active={c.seq === activeSeq} onClick={loadClip} />
            ))}
          </div>
          <div className="cl-foot">
            <span>{clips.length} clips</span>
            <button onClick={refreshClips}>Refresh</button>
          </div>
        </aside>

        {/* RIGHT GRID */}
        <div className="pipeline-grid">
          {/* TL: VIDEO */}
          <section className="pipeline-grid-cell">
            <div className="panel-label">
              <div className="panel-label-main">Match Feed</div>
              {videoReady ? <span className="pill pill-active">READY</span> : <span className="pill pill-info">LOADING</span>}
            </div>
            <div className="video-frame">
              <div className="video-shell">
                <img ref={frameRef} alt="Match footage" onLoad={() => drawVideoOverlay()} />
                <canvas ref={overlayRef} />
                {!videoReady && (
                  <div className="video-placeholder">
                    <div className="video-placeholder-spinner" />
                    <span>{clipLoadState === 'warming' ? 'Warming cache' : clipLoadState === 'error' ? 'Cache error' : 'Loading frame'}</span>
                  </div>
                )}
                <div className="video-overlay">
                  {calibPill}
                </div>
                <div className="video-diag">
                  <span><span className="diag-key">KPTS</span> <span className="diag-val">{diag.kpts}</span></span>
                  <span><span className="diag-key">CALIB</span> <span className="diag-val">{diag.calib}</span></span>
                  <span><span className="diag-key">MAP</span> <span className={`diag-val ${diag.hq >= 70 ? 'ok' : diag.hq >= 40 ? 'warn' : 'bad'}`}>{diag.hq}%</span></span>
                  <span><span className="diag-key">PLAYERS</span> <span className="diag-val">{diag.players}</span></span>
                  <span><span className="diag-key">BALL</span> <span className="diag-val">{diag.ball}</span></span>
                </div>
              </div>
              <div className="video-controls">
                <span className="video-time"><strong>{fmtTime(idx)}</strong> / {fmtTime(TOTAL_FRAMES)}</span>
                <div className="video-slider-wrap">
                  <div className="video-slider-buffered" style={{ width: `${bufferPct * 100}%` }} />
                  <input
                    className="video-slider"
                    type="range"
                    min="1"
                    max={TOTAL_FRAMES}
                    value={idx}
                    disabled={!videoReady}
                    onInput={onSlider}
                  />
                </div>
                <span className="video-buffer-pct" title="Frames prefetched and ready for instant playback">
                  {bufferedFrames > 0
                    ? (bufferedFrames >= TOTAL_FRAMES ? 'CACHED' : `BUF ${bufferedFrames}`)
                    : '—'}
                </span>
                <button className="vbtn vbtn-icon" onClick={onPrev} disabled={!videoReady || idx <= 1}>◀</button>
                <button ref={playBtnRef} className="vbtn primary" onClick={onPlay} disabled={!videoReady}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button className="vbtn vbtn-icon" onClick={onNext} disabled={!videoReady || idx >= TOTAL_FRAMES}>▶</button>
                <select ref={speedSelRef} className="vbtn" defaultValue="200" style={{ padding: '4px 6px' }}>
                  <option value="400">0.5x</option>
                  <option value="200">1x</option>
                  <option value="100">2x</option>
                </select>
              </div>
            </div>
          </section>

          {/* TR: PITCH */}
          <section className="pipeline-grid-cell">
            <div className="panel-label">
              <div className="panel-label-main">2D Pitch <span className="panel-label-sub">· Tactical View</span></div>
              {isDegenerate
                ? <span className="pill pill-bad">DEGENERATE FIT · RE-PRECOMPUTE</span>
                : diag.players > 0
                  ? <span className="pill pill-active">{diag.players} TRACKED</span>
                  : usingGT
                    ? <span className="pill pill-warn">GT FALLBACK</span>
                    : <span className="pill pill-info">AWAITING DATA</span>}
            </div>
            <div className="pitch-frame">
              <div className="pitch-shell">
                <canvas ref={pitchRef} width="640" height="440" />
                {!st.pending && (
                  <div className="pitch-empty">
                    <strong>No clip loaded</strong>
                    <p>Choose a match from the Clip Library on the left.</p>
                  </div>
                )}
              </div>
              <div className="pitch-toolbar">
                <div className="pt-group">
                  {OVERLAY_MODES.map((m) => (
                    <label key={m.id}>
                      <input type="radio" name="overlay" checked={overlayMode === m.id} onChange={() => setOverlay(m.id)} />
                      {m.title}
                    </label>
                  ))}
                </div>
                <div className="pt-group" style={{ marginLeft: 'auto' }}>
                  <label title="Show the SoccerNet ground-truth player positions as a baseline reference">
                    <input type="checkbox" checked={showGT} onChange={(e) => { setShowGT(e.target.checked); renderPitch() }} />
                    GT Baseline
                  </label>
                  <label title="Draw the projected pitch lines on the video to visualize the homography">
                    <input type="checkbox" checked={showOverlay} onChange={(e) => { setShowOverlay(e.target.checked); drawVideoOverlay() }} />
                    Pitch lines
                  </label>
                  <label title="Show player ID numbers on the pitch">
                    <input type="checkbox" checked={showIds} onChange={(e) => { setShowIds(e.target.checked); renderPitch() }} />
                    IDs
                  </label>
                </div>
                <button
                  className="vbtn"
                  onClick={startPrecompute}
                  disabled={precompute.state === 'queued' || precompute.state === 'running'}
                  title="Re-run precompute with current model weights to fix degenerate homography fits"
                >
                  {precompute.state === 'running'
                    ? `BG ${precompute.done}/${precompute.total}`
                    : precompute.state === 'queued'
                      ? 'Queued'
                      : precompute.state === 'done'
                        ? 'Done'
                        : 'Re-precompute'}
                </button>
              </div>
            </div>
          </section>

          {/* BL: BRIEFING */}
          <section className="pipeline-grid-cell">
            <div className="panel-label">
              <div className="panel-label-main">Match Briefing</div>
              <span className="panel-label-sub">{activeSeq || 'No clip'}</span>
            </div>
            <div className="briefing-body">
              <div className="brief-team">
                <div className="brief-team-label">Team 1</div>
                <div className="brief-team-name" style={{ color: t1Color }}>
                  {st.pending && st.pending.team_colors && st.pending.team_colors[0] ? 'Home' : 'Loading'}
                </div>
                <div className="brief-team-color">
                  <span className="color-swatch" style={{ background: t1Color }} />
                  <span>{t1Color.toUpperCase()} · {t1Count} on pitch</span>
                </div>
              </div>
              <div className="brief-team">
                <div className="brief-team-label">Team 2</div>
                <div className="brief-team-name" style={{ color: t2Color }}>
                  {st.pending && st.pending.team_colors && st.pending.team_colors[1] ? 'Away' : 'Loading'}
                </div>
                <div className="brief-team-color">
                  <span className="color-swatch" style={{ background: t2Color }} />
                  <span>{t2Color.toUpperCase()} · {t2Count} on pitch</span>
                </div>
              </div>
              <div className="brief-meta">
                <div className="brief-meta-item">
                  <div className="brief-meta-label">Video Time</div>
                  <div className="brief-meta-value">{fmtTime(idx)}</div>
                </div>
                <div className="brief-meta-item">
                  <div className="brief-meta-label">Frame</div>
                  <div className="brief-meta-value">{idx} / {TOTAL_FRAMES}</div>
                </div>
                <div className="brief-meta-item">
                  <div className="brief-meta-label">FPS</div>
                  <div className="brief-meta-value">{FPS}</div>
                </div>
                <div className="brief-meta-item">
                  <div className="brief-meta-label">Status</div>
                  <div className="brief-meta-value">
                    {videoReady ? 'Ready' : clipLoadState === 'warming' ? 'Warming' : 'Idle'}
                  </div>
                </div>
              </div>
              <div className="brief-event-log">
                <div className="brief-event-log-title">Events</div>
                {st.analytics.events.length === 0 && (
                  <div className="brief-event-empty">No events captured yet. Scrub through the clip to track possession changes and ball movement.</div>
                )}
                {st.analytics.events.map((e, i) => (
                  <div className="brief-event" key={i}>
                    <span className="brief-event-time">F{e.idx}</span>
                    <span className="brief-event-kind">{e.kind}</span>
                    <span>{e.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* BR: STATS */}
          <section className="pipeline-grid-cell">
            <div className="panel-label">
              <div className="panel-label-main">Tactical Stats</div>
              <span className="panel-label-sub">live from tracking</span>
            </div>
            <div className="stats-body">
              <div className="score-strip">
                <div className="score-team l">
                  <span className="score-dot" style={{ background: t1Color, boxShadow: `0 0 6px ${t1Color}` }} />
                  <span>Team 1</span>
                </div>
                <div className="score-mid">
                  <span style={{ color: t1Color }}>{t1Count}</span>
                  <span className="sep">·</span>
                  <span style={{ color: t2Color }}>{t2Count}</span>
                </div>
                <div className="score-team r">
                  <span>Team 2</span>
                  <span className="score-dot" style={{ background: t2Color, boxShadow: `0 0 6px ${t2Color}` }} />
                </div>
              </div>
              <div className="poss-strip">
                <div className="poss-side l">
                  <div className="poss-pct" style={{ color: t1Color }}>{t1Poss}%</div>
                  <div className="poss-lbl">Poss</div>
                </div>
                <PossessionDonut p1={t1Poss} p2={t2Poss} c1={t1Color} c2={t2Color} />
                <div className="poss-side r">
                  <div className="poss-pct" style={{ color: t2Color }}>{t2Poss}%</div>
                  <div className="poss-lbl">Poss</div>
                </div>
              </div>
              <div className="metric-strip">
                <MetricCard label="BALL" value={(() => {
                  if (!st.pending || !st.pending.ball || st.history.length < 2) return '—'
                  const a = st.history[st.history.length - 2]
                  const b = st.history[st.history.length - 1]
                  if (!a.ballPitch || !b.ballPitch) return '—'
                  return (distM(a.ballPitch, b.ballPitch) * FPS * 3.6).toFixed(1)
                })()} unit="km/h" />
                <MetricCard label="SPRINTS" value={totalSprints} unit="frm" />
                <MetricCard label="POSS Δ" value={totalPasses} unit="x" />
                <MetricCard label="IN BOX" value={totalInBox} unit="frm" />
              </div>
              <div className="bar-rows">
                {bars.map((b) => <BarRow key={b.label} row={b} />)}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

export default PipelineScreen
