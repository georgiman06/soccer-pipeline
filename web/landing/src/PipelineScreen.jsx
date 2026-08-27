import { useEffect, useRef } from 'react'
import './PipelineScreen.css'

const TOTAL_FRAMES = 750

function PipelineScreen() {
  const st = useRef({
    seqs: [],
    seq: null,
    idx: 1,
    playing: false,
    busy: false,
    pending: null,
    precomputed: {},
    teamColors: [null, null],
    lastAdv: 0,
    avgDt: 0,
  }).current
  const alive = useRef(true)

  const frameRef = useRef(null)
  const overlayRef = useRef(null)
  const pitchRef = useRef(null)
  const seqSelRef = useRef(null)
  const sliderRef = useRef(null)
  const statusRef = useRef(null)
  const playBtnRef = useRef(null)
  const precompBtnRef = useRef(null)
  const precompAllBtnRef = useRef(null)
  const markToggleRef = useRef(null)
  const gtToggleRef = useRef(null)
  const overlayToggleRef = useRef(null)
  const idToggleRef = useRef(null)
  const speedSelRef = useRef(null)
  const swTeam0Ref = useRef(null)
  const swTeam1Ref = useRef(null)

  function updateTeamColors(colors) {
    if (!Array.isArray(colors) || colors.length !== 2 || colors.some((c) => typeof c !== 'string')) return
    st.teamColors = colors
    if (swTeam0Ref.current) swTeam0Ref.current.style.background = colors[0]
    if (swTeam1Ref.current) swTeam1Ref.current.style.background = colors[1]
  }

  function playerColor(p) {
    if ((p.team === 0 || p.team === 1) && st.teamColors[p.team]) return st.teamColors[p.team]
    return '#ffffff'
  }

  function chip(label, cls = '') {
    return `<span class="pipeline-chip ${cls}">${label}</span>`
  }

  function setStatus(html) {
    if (statusRef.current) statusRef.current.innerHTML = html
  }

  function startPrecompute() {
    if (!st.seq) return
    if (st.precomputed[st.seq] === 'done') {
      setStatus(chip('clip already precomputed — press Play', 'ok'))
      return
    }
    if (precompBtnRef.current) precompBtnRef.current.disabled = true
    setStatus(chip('precompute started...', 'info'))
    fetch(`/api/precompute/${st.seq}`, { method: 'POST' }).then(() => pollProgress())
  }

  function pollProgress() {
    fetch(`/api/progress/${st.seq}`)
      .then((r) => r.json())
      .then((p) => {
        if (!alive.current) return
        if (p.total > 0) {
          setStatus(
            chip(
              `precomputing ${p.done}/${p.total} frames (~${Math.max(0, Math.round(((p.total - p.done) * 3) / 60))} min left)`,
              'info',
            ),
          )
        }
        if (p.finished) {
          st.precomputed[st.seq] = 'done'
          if (precompBtnRef.current) {
            precompBtnRef.current.disabled = false
            precompBtnRef.current.textContent = 'Precompute clip'
          }
          setStatus(chip('clip ready — press Play', 'ok'))
        } else {
          setTimeout(() => alive.current && pollProgress(), 3000)
        }
      })
      .catch(() => setTimeout(() => alive.current && pollProgress(), 5000))
  }

  function pollQueue() {
    fetch('/api/queue_status')
      .then((r) => r.json())
      .then((q) => {
        if (!alive.current) return
        const cur = q.clips.find((c) => !c.finished)
        if (q.running && cur) {
          setStatus(
            chip(`bg precompute: ${cur.seq} ${cur.done}/${cur.total}`, 'info') +
              chip(`${q.queued.length} clips queued`),
          )
          if (cur.seq === st.seq && cur.done >= st.idx) st.precomputed[st.seq] = 'done'
          setTimeout(() => alive.current && pollQueue(), 3000)
        } else {
          if (precompAllBtnRef.current) precompAllBtnRef.current.disabled = false
          if (st.playing) return
          setStatus(chip('background precompute finished — all clips ready', 'ok'))
          for (const s of st.seqs) st.precomputed[s] = 'done'
        }
      })
      .catch(() => setTimeout(() => alive.current && pollQueue(), 5000))
  }

  function precomputeAll() {
    if (!window.confirm('Precompute ALL clips? ~30 min each — runs in the background for hours (resumable; finished clips are skipped). Continue?')) return
    if (precompAllBtnRef.current) precompAllBtnRef.current.disabled = true
    fetch('/api/precompute_all', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        setStatus(
          d.queued
            ? chip(`queued ${d.queued} clips for background precompute`, 'info')
            : chip('all clips already precomputed', 'ok'),
        )
        if (d.queued) pollQueue()
      })
  }

  function statusChips(d) {
    const b = d.ball ? (d.ball.coasting ? 'ball coasting' : `ball ${d.ball.conf}`) : 'ball —'
    const calibCls = d.calib_source === 'model' ? 'ok' : d.calib_source === 'frozen' || d.calib_source === 'none' ? 'bad' : 'warn'
    const hq =
      d.h_quality != null
        ? chip(`map ${Math.round(d.h_quality * 100)}%`, d.h_quality > 0.7 ? 'ok' : d.h_quality >= 0.4 ? 'warn' : 'bad')
        : ''
    const reacq = d.calib_source === 'frozen' || d.calib_source === 'held' ? chip('REACQUIRING', 'warn') : ''
    let speed = ''
    if (st.playing && st.avgDt > 0) {
      const fps = 1000 / st.avgDt
      speed = chip(`${fps.toFixed(1)} fps (${Math.min(fps / 25, 9.99).toFixed(2)}x)`, 'info')
    }
    const teams = st.teamColors[0] && st.teamColors[1] ? chip('teams locked', 'ok') : ''
    const k = d.kpts ? `${d.kpts.visible}/${d.kpts.total}` : '?'
    setStatus(
      chip(`frame ${d.idx}`) +
        chip(`players ${d.players.length} · GT ${d.gt.players_img.length}`) +
        chip(b) +
        chip(`kpts ${k}`) +
        chip(`calib ${d.calib_source}`, calibCls) +
        teams +
        hq +
        reacq +
        speed,
    )
  }

  function drawPitch() {
    const c = pitchRef.current
    if (!c) return { X: () => 0, Y: () => 0 }
    const ctx = c.getContext('2d')
    const W = 105
    const H = 68
    const m = 8
    const cw = c.width
    const ch = c.height
    const s = Math.min((cw - 2 * m) / W, (ch - 2 * m) / H)
    const X = (x) => m + (x + 2.5) * s
    const Y = (y) => m + (y + 2.5) * s
    ctx.clearRect(0, 0, cw, ch)

    ctx.fillStyle = '#1a5e2a'
    ctx.fillRect(X(0), Y(0), W * s, H * s)

    const grad = ctx.createLinearGradient(X(0), Y(0), X(0), Y(H))
    grad.addColorStop(0, '#1e6b2a')
    grad.addColorStop(1, '#164e1a')
    ctx.fillStyle = grad
    ctx.fillRect(X(0), Y(0), W * s, H * s)

    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeRect(X(0), Y(0), W * s, H * s)

    ctx.beginPath()
    ctx.moveTo(X(52.5), Y(0))
    ctx.lineTo(X(52.5), Y(68))
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(X(52.5), Y(34), 9.15 * s, 0, 2 * Math.PI)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(X(52.5), Y(34), 0.8 * s, 0, 2 * Math.PI)
    ctx.fill()

    for (const side of [[0, 1], [105, -1]]) {
      const [gx, dir] = side
      ctx.strokeRect(X(Math.min(gx, gx + 16.5 * dir)), Y(13.84), 16.5 * s, 40.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 5.5 * dir)), Y(24.84), 5.5 * s, 18.32 * s)
      ctx.strokeRect(X(Math.min(gx, gx + 2 * dir)), Y(34 - 3.66), 2 * s, 7.32 * s)

      const penSpot = dir === 1 ? [11, 34] : [94, 34]
      ctx.beginPath()
      ctx.arc(X(penSpot[0]), Y(penSpot[1]), 0.8 * s, 0, 2 * Math.PI)
      ctx.fill()

      const arcX = dir === 1 ? 11 : 94
      const arcStart = dir === 1 ? 0.55 : 2.55
      const arcEnd = dir === 1 ? 5.75 : 3.75
      ctx.beginPath()
      ctx.arc(X(arcX), Y(34), 8 * s, arcStart * Math.PI, arcEnd * Math.PI)
      ctx.stroke()
    }

    return { X, Y }
  }

  function dot(ctx, p, X, Y, color, r, hollow) {
    const x = X(p[0])
    const y = Y(p[1])
    if (!isFinite(x) || !isFinite(y)) return
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    if (hollow) {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.fill()
    }
  }

  function inField(p) {
    return p && p[0] > -3 && p[0] < 108 && p[1] > -3 && p[1] < 71
  }

  function render() {
    const d = st.pending
    if (!d) return
    updateTeamColors(d.team_colors)
    const { X, Y } = drawPitch()
    const ctx = pitchRef.current.getContext('2d')
    const showGT = gtToggleRef.current?.checked

    if (showGT) {
      for (const p of d.gt.players_pitch) if (inField(p)) dot(ctx, p, X, Y, '#ffffff', 4.5, true)
      for (const p of d.gt.ball_pitch) if (inField(p)) dot(ctx, p, X, Y, '#ffb020', 4, true)
    }
    const frozenMode = d.calib_source === 'frozen'
    for (const p of d.players) {
      if (p.pitch && inField(p.pitch)) {
        ctx.globalAlpha = p.coasting ? 0.5 : frozenMode ? 0.75 : 1.0
        dot(ctx, p.pitch, X, Y, playerColor(p), 4, false)
        if (idToggleRef.current?.checked) {
          ctx.fillStyle = '#e8eef2'
          ctx.font = '10px Segoe UI'
          ctx.fillText('#' + p.id, X(p.pitch[0]) + 6, Y(p.pitch[1]) - 5)
        }
      }
    }
    ctx.globalAlpha = 1.0
    if (d.ball && d.ball.pitch && inField(d.ball.pitch)) {
      dot(ctx, d.ball.pitch, X, Y, d.ball.coasting ? '#808080' : '#ffb020', 5.5, false)
    }
    drawOverlay(overlayToggleRef.current?.checked)
  }

  function drawOverlay(showLines) {
    const img = frameRef.current
    const cv = overlayRef.current
    if (!img || !cv) return
    if (!img.naturalWidth) {
      requestAnimationFrame(() => drawOverlay(showLines))
      return
    }
    const scale = img.clientWidth / img.naturalWidth
    cv.width = img.clientWidth
    cv.height = img.clientHeight
    cv.style.left = img.offsetLeft + 'px'
    cv.style.top = img.offsetTop + 'px'
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, cv.width, cv.height)
    const d = st.pending
    if (!d) return

    if (showLines && d.overlay_lines) {
      ctx.strokeStyle = 'rgba(255,77,210,0.9)'
      ctx.lineWidth = 1.5
      for (const line of d.overlay_lines) {
        ctx.beginPath()
        ctx.moveTo(line[0][0] * scale, line[0][1] * scale)
        ctx.lineTo(line[1][0] * scale, line[1][1] * scale)
        ctx.stroke()
      }
    }

    if (!markToggleRef.current?.checked) return
    const frozenMode = d.calib_source === 'frozen'
    for (const p of d.players) {
      if (!p.img) continue
      const t = Math.min(1, Math.max(0, p.img[1] / img.naturalHeight))
      const rx = Math.max(6, img.clientWidth * (0.008 + 0.014 * t))
      const x = p.img[0] * scale
      const y = p.img[1] * scale
      ctx.globalAlpha = p.coasting ? 0.45 : frozenMode ? 0.8 : 1.0
      ctx.strokeStyle = playerColor(p)
      ctx.lineWidth = Math.max(2, rx * 0.16)
      ctx.beginPath()
      ctx.ellipse(x, y, rx, rx * 0.38, 0, 0, 2 * Math.PI)
      ctx.stroke()
      if (idToggleRef.current?.checked) {
        ctx.fillStyle = '#ffffff'
        ctx.font = `600 ${Math.max(10, rx * 0.55)}px Segoe UI`
        ctx.textAlign = 'center'
        ctx.fillText('#' + p.id, x, y - rx * 0.75)
        ctx.textAlign = 'left'
      }
    }
    if (d.ball && d.ball.img) {
      const t = Math.min(1, Math.max(0, d.ball.img[1] / img.naturalHeight))
      const r = Math.max(4, img.clientWidth * (0.004 + 0.006 * t))
      ctx.globalAlpha = d.ball.coasting ? 0.45 : 1.0
      ctx.strokeStyle = '#ffb020'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(d.ball.img[0] * scale, d.ball.img[1] * scale, r, 0, 2 * Math.PI)
      ctx.stroke()
    }
    ctx.globalAlpha = 1.0
  }

  function load() {
    st.busy = true
    const reqIdx = st.idx
    setStatus(chip(`processing frame ${reqIdx} ...`, 'info'))
    if (frameRef.current) frameRef.current.src = `/api/frame/${st.seq}/${reqIdx}`
    fetch(`/api/process/${st.seq}/${reqIdx}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive.current) return
        if (reqIdx !== st.idx || d.error) {
          st.busy = false
          if (d.error) setStatus(chip(`frame ${reqIdx}: ${d.error}`, 'bad'))
          return
        }
        st.pending = d
        render()
        st.busy = false
        statusChips(d)
      })
      .catch(() => {
        if (!alive.current) return
        st.busy = false
        setStatus(chip(`error processing frame ${reqIdx}`, 'bad'))
      })
  }

  function tick() {
    if (!st.playing) return
    const fpsMode = st.precomputed[st.seq] === 'done'
    if (!st.busy && st.idx < TOTAL_FRAMES) {
      const now = performance.now()
      if (st.lastAdv) {
        const dt = now - st.lastAdv
        st.avgDt = st.avgDt ? 0.8 * st.avgDt + 0.2 * dt : dt
      }
      st.lastAdv = now
      st.idx++
      if (sliderRef.current) sliderRef.current.value = st.idx
      load()
    }
    setTimeout(() => alive.current && tick(), fpsMode ? +speedSelRef.current.value : 120)
  }

  function onSeqChange(e) {
    st.seq = e.target.value
    st.idx = 1
    if (sliderRef.current) sliderRef.current.value = 1
    st.lastAdv = 0
    st.avgDt = 0
    load()
  }

  function onSliderInput(e) {
    st.idx = +e.target.value
    if (!st.busy) load()
  }

  function onPrev() {
    if (st.idx > 1) {
      st.idx--
      if (sliderRef.current) sliderRef.current.value = st.idx
      if (!st.busy) load()
    }
  }

  function onNext() {
    if (st.idx < TOTAL_FRAMES) {
      st.idx++
      if (sliderRef.current) sliderRef.current.value = st.idx
      if (!st.busy) load()
    }
  }

  function onPlay() {
    st.playing = !st.playing
    if (playBtnRef.current) playBtnRef.current.textContent = st.playing ? 'Pause' : 'Play'
    if (st.playing) {
      st.lastAdv = 0
      st.avgDt = 0
      tick()
    }
  }

  useEffect(() => {
    alive.current = true
    fetch('/api/sequences')
      .then((r) => r.json())
      .then((s) => {
        if (!alive.current) return
        st.seqs = s
        if (seqSelRef.current) seqSelRef.current.innerHTML = s.map((x) => `<option>${x}</option>`).join('')
        st.seq = s[0]
        load()
        fetch('/api/queue_status')
          .then((r) => r.json())
          .then((q) => {
            if (!alive.current) return
            for (const c of q.clips) if (c.finished) st.precomputed[c.seq] = 'done'
            if (q.running) {
              if (precompAllBtnRef.current) precompAllBtnRef.current.disabled = true
              pollQueue()
            }
          })
          .catch(() => {})
      })
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="pipeline-screen">
      <main className="pipeline-grid">
        <section className="pipeline-video-panel">
          <div className="pipeline-video-wrapper">
            <img ref={frameRef} alt="frame" />
            <canvas ref={overlayRef}></canvas>
          </div>
          <input ref={sliderRef} type="range" min="1" max={TOTAL_FRAMES} defaultValue="1" onInput={onSliderInput} />
          <div ref={statusRef} className="pipeline-status"><span className="pipeline-chip">loading...</span></div>
        </section>

        <section className="pipeline-pitch-panel">
          <div className="pipeline-pitch-toolbar">
            <label><input ref={markToggleRef} type="checkbox" defaultChecked onChange={() => drawOverlay(overlayToggleRef.current?.checked)} /> Markers</label>
            <label><input ref={gtToggleRef} type="checkbox" defaultChecked onChange={render} /> Ground truth</label>
            <label><input ref={overlayToggleRef} type="checkbox" defaultChecked onChange={() => drawOverlay(overlayToggleRef.current?.checked)} /> Pitch lines</label>
            <label><input ref={idToggleRef} type="checkbox" onChange={render} /> IDs</label>
          </div>
          <canvas ref={pitchRef} width="640" height="440" className="pipeline-pitch-canvas"></canvas>
          <div className="pipeline-legend">
            <span><span ref={swTeam0Ref} className="pipeline-sw" style={{ background: '#fff' }}></span>team 1 (auto)</span>
            <span><span ref={swTeam1Ref} className="pipeline-sw" style={{ background: '#fff' }}></span>team 2 (auto)</span>
            <span><span className="pipeline-sw" style={{ background: 'transparent', border: '2px solid #fff', width: 6, height: 6 }}></span>player (GT)</span>
            <span><span className="pipeline-sw" style={{ background: '#ffb020' }}></span>ball</span>
            <span><span className="pipeline-sw" style={{ background: 'transparent', border: '2px solid #ffb020', width: 6, height: 6 }}></span>ball (GT)</span>
            <span><span className="pipeline-sw" style={{ background: 'transparent', border: '2px dashed #ff4dd2', width: 6, height: 6, borderRadius: 0 }}></span>pitch lines (calib)</span>
          </div>
        </section>

        <section className="pipeline-stats-panel">
          <h2>Match Stats</h2>
          <div className="pipeline-stats-placeholder">
            <p>Match statistics — API integration pending</p>
          </div>
        </section>

        <section className="pipeline-settings-panel">
          <div className="pipeline-settings-group">
            <h3>Clip</h3>
            <select ref={seqSelRef} onChange={onSeqChange}></select>
            <button ref={precompBtnRef} onClick={startPrecompute}>Precompute clip</button>
            <button ref={precompAllBtnRef} onClick={precomputeAll}>Precompute ALL</button>
          </div>
          <div className="pipeline-settings-group">
            <h3>Playback</h3>
            <button onClick={onPrev}>&#9664;</button>
            <button ref={playBtnRef} onClick={onPlay}>Play</button>
            <button onClick={onNext}>&#9654;</button>
            <select ref={speedSelRef} title="playback speed" defaultValue="40">
              <option value="80">0.5x</option>
              <option value="40">1x</option>
              <option value="20">2x</option>
            </select>
          </div>
        </section>
      </main>
    </div>
  )
}

export default PipelineScreen
