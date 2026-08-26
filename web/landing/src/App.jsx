import { useState } from 'react'
import './index.css'
import LandingPage from './LandingPage'
import PipelineScreen from './PipelineScreen'

function App() {
  const [view, setView] = useState('landing')

  if (view === 'pipeline') {
    return <PipelineScreen />
  }

  return <LandingPage onDone={() => setView('pipeline')} />
}

export default App
