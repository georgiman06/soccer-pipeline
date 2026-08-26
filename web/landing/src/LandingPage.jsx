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
