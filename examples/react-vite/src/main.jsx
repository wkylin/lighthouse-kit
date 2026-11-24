import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'

function Home() {
  return (
    <main>
      <h1>Home</h1>
      <p>A small page for lhkit to scan.</p>
      <Link to="/about">About</Link>
    </main>
  )
}

function About() {
  return (
    <main>
      <h1>About</h1>
      <p>The second route.</p>
      <Link to="/">Home</Link>
    </main>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

// 一个大模块，首屏只用到其中一项：单独成块，让扫描报告的“未使用的 JavaScript”对到 src/catalog.js。
import('./catalog.js').then((m) => {
  document.body.dataset.sample = m.describe('item1', 2)
})
