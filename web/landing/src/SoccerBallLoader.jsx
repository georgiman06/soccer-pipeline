import './SoccerBallLoader.css'

function SoccerBallLoader({ size = 64 }) {
  return (
    <svg
      className="soccer-ball-loader"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Loading"
    >
      <circle cx="50" cy="50" r="48" fill="#fff" stroke="#111" strokeWidth="2" />
      <polygon points="50,30 61,38 57,51 43,51 39,38" fill="#111" />
      <polygon points="50,30 39,38 30,30 34,16 50,12" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="50,30 61,38 70,30 66,16 50,12" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="43,51 57,51 62,64 50,74 38,64" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="39,38 30,30 15,36 15,54 27,60" fill="#fff" stroke="#111" strokeWidth="1.5" />
      <polygon points="61,38 70,30 85,36 85,54 73,60" fill="#fff" stroke="#111" strokeWidth="1.5" />
    </svg>
  )
}

export default SoccerBallLoader
