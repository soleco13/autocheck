import { useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'

interface Props {
  documentId: string
  fallbackColor: string
}

export default function PdfCover({ documentId, fallbackColor }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')

    ;(async () => {
      try {
        // Ленивая загрузка pdfjs-dist — не попадает в основной бандл
        const pdfjsLib = await import('pdfjs-dist')

        // Worker через Vite URL import (без CDN)
        const workerUrl = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url,
        ).href
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

        const loadingTask = pdfjsLib.getDocument({
          url: `/api/textbooks/${documentId}/cover`,
          withCredentials: true,
        })
        const pdf = await loadingTask.promise
        if (cancelled) return

        const page = await pdf.getPage(1)
        if (cancelled) return

        const canvas = canvasRef.current
        if (!canvas) return

        // Рендерим с шириной контейнера (~68px × dpr для чёткости)
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const containerW = canvasRef.current?.parentElement?.clientWidth || 68
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = (containerW / baseViewport.width) * dpr
        const viewport = page.getViewport({ scale })

        canvas.width  = viewport.width
        canvas.height = viewport.height

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        await page.render({ canvasContext: ctx as any, viewport, canvas }).promise
        if (!cancelled) setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    })()

    return () => { cancelled = true }
  }, [documentId])

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: fallbackColor + '18',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Canvas всегда в DOM, просто скрыт пока грузится */}
      <canvas
        ref={canvasRef}
        style={{
          display: state === 'ready' ? 'block' : 'none',
          width: '100%',
          height: 'auto',
          objectFit: 'fill',
        }}
      />

      {/* Fallback пока грузится или при ошибке */}
      {state !== 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: 0.5 }}>
          {state === 'loading'
            ? <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, borderColor: fallbackColor }} />
            : <BookOpen size={24} color={fallbackColor} />
          }
        </div>
      )}
    </div>
  )
}
