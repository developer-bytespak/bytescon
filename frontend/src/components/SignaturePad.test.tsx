// =============================================================
// §8.4 — Signature pad.
//
// jsdom has no real 2D context, so these cover the parts that are logic rather
// than pixels: what the controls allow at each moment, that a new stroke
// discards the redo trail, and — most importantly — that the panel says this
// is a captured image and not a binding signature.
// =============================================================
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SignaturePad } from './SignaturePad'

// jsdom returns null from getContext, which would make every draw a no-op and
// hide real failures. A recording stub keeps the component's own logic honest.
function stubCanvas() {
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), quadraticCurveTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    translate: vi.fn(),
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAA')
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(['x'], { type: 'image/png' }))
  } as HTMLCanvasElement['toBlob'])
  return ctx
}

// ResizeObserver does not exist in jsdom.
class RO { observe() {} disconnect() {} unobserve() {} }
;(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO

const draw = (canvas: HTMLElement, points: Array<[number, number]>) => {
  const [first, ...rest] = points
  fireEvent.pointerDown(canvas, { clientX: first[0], clientY: first[1], pointerId: 1, pressure: 0.5 })
  for (const [x, y] of rest) {
    fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1, pressure: 0.5 })
  }
  fireEvent.pointerUp(canvas, { pointerId: 1 })
}

beforeEach(() => {
  vi.restoreAllMocks()
  stubCanvas()
  // setPointerCapture is not implemented in jsdom.
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('SignaturePad — controls', () => {
  it('starts with nothing to undo, redo, clear or export', () => {
    render(<SignaturePad />)
    expect(screen.getByRole('button', { name: /Undo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Redo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Clear/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Download PNG/ })).toBeDisabled()
  })

  it('prompts the reader to draw while the pad is empty', () => {
    render(<SignaturePad />)
    expect(screen.getByText(/Draw your signature here/i)).toBeInTheDocument()
  })

  it('enables undo, clear and export once something is drawn', () => {
    render(<SignaturePad />)
    draw(screen.getByLabelText('Signature drawing area'), [[10, 10], [30, 20], [50, 15]])
    expect(screen.getByRole('button', { name: /Undo/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Clear/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Download PNG/ })).toBeEnabled()
  })

  it('undo takes the last stroke back and redo returns it', () => {
    render(<SignaturePad />)
    const canvas = screen.getByLabelText('Signature drawing area')
    draw(canvas, [[10, 10], [30, 20]])
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))

    expect(screen.getByRole('button', { name: /Undo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Redo/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Redo/ }))
    expect(screen.getByRole('button', { name: /Undo/ })).toBeEnabled()
  })

  it('a new stroke discards the redo trail', () => {
    render(<SignaturePad />)
    const canvas = screen.getByLabelText('Signature drawing area')
    draw(canvas, [[10, 10], [30, 20]])
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(screen.getByRole('button', { name: /Redo/ })).toBeEnabled()

    draw(canvas, [[40, 40], [60, 50]])
    expect(screen.getByRole('button', { name: /Redo/ })).toBeDisabled()
  })

  it('clear asks first and then empties the pad', () => {
    render(<SignaturePad />)
    draw(screen.getByLabelText('Signature drawing area'), [[10, 10], [30, 20]])
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(window.confirm).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Undo/ })).toBeDisabled()
    expect(screen.getByText(/Draw your signature here/i)).toBeInTheDocument()
  })

  it('keeps the drawing when clearing is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SignaturePad />)
    draw(screen.getByLabelText('Signature drawing area'), [[10, 10], [30, 20]])
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(screen.getByRole('button', { name: /Undo/ })).toBeEnabled()
  })

  it('carries a pen size and an ink colour', () => {
    render(<SignaturePad />)
    const size = screen.getByLabelText('Pen size') as HTMLInputElement
    fireEvent.change(size, { target: { value: '8' } })
    expect(size.value).toBe('8')

    const black = screen.getByRole('button', { name: 'Black' })
    fireEvent.click(black)
    expect(black).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('SignaturePad — capture', () => {
  it('hands the drawing back as a PNG file when a consumer wants it', async () => {
    const onCapture = vi.fn()
    render(<SignaturePad onCapture={onCapture} />)
    draw(screen.getByLabelText('Signature drawing area'), [[10, 10], [30, 20], [50, 15]])
    fireEvent.click(screen.getByRole('button', { name: /Use this signature/ }))
    await waitFor(() => expect(onCapture).toHaveBeenCalled())
    const [file, dataUrl] = onCapture.mock.calls[0]
    expect(file).toBeInstanceOf(File)
    expect(file.type).toBe('image/png')
    expect(dataUrl).toMatch(/^data:image\/png/)
  })

  it('offers a download instead when nothing is consuming it', () => {
    render(<SignaturePad />)
    expect(screen.getByRole('button', { name: /Download PNG/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use this signature/ })).not.toBeInTheDocument()
  })
})

describe('SignaturePad — honesty', () => {
  it('says the drawing is not a binding signature', () => {
    render(<SignaturePad />)
    expect(screen.getByText(/not a binding signature/i)).toBeInTheDocument()
  })

  it('says the provider collects the real one from the signer', () => {
    render(<SignaturePad />)
    expect(screen.getByText(/collects that from the signer themselves/i)).toBeInTheDocument()
  })
})
