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
