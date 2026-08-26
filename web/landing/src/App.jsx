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
