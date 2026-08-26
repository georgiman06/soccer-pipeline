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
