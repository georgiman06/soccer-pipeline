import { useState } from 'react'
import Typewriter from './Typewriter'
import SoccerBallLoader from './SoccerBallLoader'
import './LandingPage.css'

const HEADLINE = "Let's Analyze Some Soccer!"
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
      <img
        className="bg-video"
        src="/world_cup_bg.webp"
        alt=""
        aria-hidden="true"
        loading="eager"
      />
      <div className="landing-brand">
        <span className="landing-brand-logo">S</span>
        <span>SPORTVIZ PRO / Analytics</span>
      </div>
      <h1 className="landing-headline">
        <Typewriter text={HEADLINE} onDone={handleTypingDone} />
      </h1>
      <div className="landing-sub">UEFA CHAMPIONS LEAGUE · MATCH INTELLIGENCE</div>
      {!typingDone && <SoccerBallLoader size={42} />}
      <div className="landing-pill">● LIVE</div>
    </div>
  )
}

export default LandingPage
