// =============================================================
// §8.4 — Signature pad.
//
// This CAPTURES a signature as an image. It does not sign anything: the
// binding signature is collected by the e-signature provider from the signer
// themselves, and a drawing made on your own screen is not that. Saying so on
// the panel matters more than any control on it.
//
// Strokes are kept as point lists rather than as pixels, so undo/redo replays
// the drawing instead of snapshotting the bitmap — which keeps memory flat no
// matter how long someone draws, and keeps the export crisp at any scale.
// =============================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Eraser, Redo2, Undo2 } from 'lucide-react'

interface Point { x: number; y: number; w: number }
interface Stroke { colour: string; points: Point[] }

const INKS = [
  { key: 'ink', label: 'Ink blue', value: '#1c3f94' },
  { key: 'black', label: 'Black', value: '#111318' },
  { key: 'grey', label: 'Grey', value: '#4b5563' },
] as const

const MIN_WIDTH = 1
const MAX_WIDTH = 12
/** Padding kept around the ink when exporting, in CSS pixels. */
const EXPORT_PADDING = 12

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'

export interface SignaturePadProps {
  /** Called with the trimmed PNG whenever the drawing is exported. */
  onCapture?: (file: File, dataUrl: string) => void
  /** Label shown above the pad. */
  label?: string
}

export function SignaturePad({ onCapture, label = 'Signature pad' }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [undone, setUndone] = useState<Stroke[]>([])
  const [penWidth, setPenWidth] = useState(3)
  const [colour, setColour] = useState<string>(INKS[0].value)
  const [drawing, setDrawing] = useState(false)

  // The live stroke is held in a ref while the pointer is down: re-rendering on
  // every pointer sample would drop points on a slower device.
  const live = useRef<Stroke | null>(null)

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const all = live.current ? [...strokes, live.current] : strokes
    for (const stroke of all) {
      const pts = stroke.points
      if (pts.length === 0) continue
      ctx.strokeStyle = stroke.colour

      if (pts.length === 1) {
        ctx.beginPath()
        ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2)
        ctx.fillStyle = stroke.colour
        ctx.fill()
        continue
      }

      // Segment-by-segment so each sample can carry its own width — that is
      // what makes a pressure-sensitive stylus look like a pen rather than a
      // uniform marker.
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        ctx.lineWidth = (a.w + b.w) / 2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        // Quadratic through the midpoint smooths the polyline without
        // lagging behind the cursor.
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        ctx.quadraticCurveTo(a.x, a.y, mx, my)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }
  }, [strokes])

  // Size the backing store to the device pixel ratio so the ink is not blurry
  // on a retina screen, and re-paint whenever the box changes size.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = wrap.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      paint()
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [paint])

  useEffect(() => { paint() }, [paint])

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    // `pressure` is 0 for a mouse and 0.5 as a neutral default, so a mouse
    // draws at the chosen width and a stylus modulates around it.
    const pressure = e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.5
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      w: Math.max(MIN_WIDTH, penWidth * (0.5 + pressure)),
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    live.current = { colour, points: [pointFrom(e)] }
    setDrawing(true)
    paint()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!live.current) return
    live.current.points.push(pointFrom(e))
    paint()
  }

  const endStroke = () => {
    if (!live.current) return
    const finished = live.current
    live.current = null
    setDrawing(false)
    if (finished.points.length > 0) {
      setStrokes((prev) => [...prev, finished])
      // A new stroke discards the redo trail, the same as every editor.
      setUndone([])
    }
  }

  const undo = () => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      setUndone((u) => [...u, last])
      return prev.slice(0, -1)
    })
  }

  const redo = () => {
    setUndone((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      setStrokes((s) => [...s, last])
      return prev.slice(0, -1)
    })
  }

  const clear = () => {
    if (strokes.length === 0) return
    if (!window.confirm('Clear the signature?')) return
    setStrokes([])
    setUndone([])
  }

  /** The ink's bounding box, so the export is the signature and not the box. */
  const inkBounds = () => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of strokes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x - p.w)
        minY = Math.min(minY, p.y - p.w)
        maxX = Math.max(maxX, p.x + p.w)
        maxY = Math.max(maxY, p.y + p.w)
      }
    }
    if (minX === Infinity) return null
    return { minX, minY, maxX, maxY }
  }

  const exportPng = () => {
    const bounds = inkBounds()
    if (!bounds) return
    const dpr = window.devicePixelRatio || 1

    const w = bounds.maxX - bounds.minX + EXPORT_PADDING * 2
    const h = bounds.maxY - bounds.minY + EXPORT_PADDING * 2

    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(w * dpr))
    out.height = Math.max(1, Math.round(h * dpr))
    const ctx = out.getContext('2d')
    if (!ctx) return

    // Transparent background on purpose: a signature image is placed over a
    // document, and a white block would cover whatever it sits on.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.translate(EXPORT_PADDING - bounds.minX, EXPORT_PADDING - bounds.minY)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const stroke of strokes) {
      const pts = stroke.points
      ctx.strokeStyle = stroke.colour
      ctx.fillStyle = stroke.colour
      if (pts.length === 1) {
        ctx.beginPath()
        ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        ctx.lineWidth = (a.w + b.w) / 2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    const dataUrl = out.toDataURL('image/png')
    out.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], 'signature.png', { type: 'image/png' })
      if (onCapture) {
        onCapture(file, dataUrl)
      } else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'signature.png'
        a.click()
        URL.revokeObjectURL(url)
      }
    }, 'image/png')
  }

  const empty = strokes.length === 0
  const control = 'text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-40 flex items-center gap-1'

  return (
    <div className={`${PANEL} space-y-3`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-semibold text-gray-200">{label}</p>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={undo} disabled={empty} className={control} aria-label="Undo last stroke">
            <Undo2 className="w-3 h-3" /> Undo
          </button>
          <button type="button" onClick={redo} disabled={undone.length === 0} className={control} aria-label="Redo stroke">
            <Redo2 className="w-3 h-3" /> Redo
          </button>
          <button type="button" onClick={clear} disabled={empty} className={control} aria-label="Clear signature">
            <Eraser className="w-3 h-3" /> Clear
          </button>
        </div>
      </div>

      <div ref={wrapRef}
        className="relative h-44 rounded-lg border border-gray-700 bg-[#fdfdfb] overflow-hidden touch-none">
        {/* A baseline, the way a paper signature block has one. */}
        <div className="absolute left-6 right-6 bottom-10 border-b border-dashed border-gray-300 pointer-events-none" />
        {empty && !drawing && (
          <p className="absolute inset-0 flex items-center justify-center text-[12px] text-gray-400 pointer-events-none">
            Draw your signature here
          </p>
        )}
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Signature drawing area"
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">Pen size</span>
          <input type="range" aria-label="Pen size" min={MIN_WIDTH} max={MAX_WIDTH} value={penWidth}
            onChange={(e) => setPenWidth(Number(e.target.value))} className="w-28" />
          <span className="text-[11px] font-mono text-gray-400 w-5">{penWidth}</span>
        </label>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">Ink</span>
          {INKS.map((ink) => (
            <button key={ink.key} type="button" onClick={() => setColour(ink.value)}
              aria-label={ink.label} aria-pressed={colour === ink.value}
              className={`w-5 h-5 rounded-full border-2 ${colour === ink.value ? 'border-amber-400' : 'border-gray-700'}`}
              style={{ background: ink.value }} />
          ))}
        </div>

        <button type="button" onClick={exportPng} disabled={empty}
          className="ml-auto text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" /> {onCapture ? 'Use this signature' : 'Download PNG'}
        </button>
      </div>

      <p className="text-[10px] text-gray-600">
        This captures a signature as a transparent PNG. It is not a binding signature — the e-signature provider
        collects that from the signer themselves, on their own device.
      </p>
    </div>
  )
}
