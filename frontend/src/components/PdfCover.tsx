import { useState } from 'react'
import { BookOpen } from 'lucide-react'

interface Props {
  documentId: string
  fallbackColor: string
}

// Обложка рендерится один раз на сервере (первая страница PDF → PNG) при индексации
// и отдаётся как статичная картинка — надёжнее и быстрее, чем рендер PDF в браузере.
export default function PdfCover({ documentId, fallbackColor }: Props) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: fallbackColor + '18',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {!errored && (
        <img
          src={`/api/textbooks/${documentId}/cover`}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          style={{
            display: loaded ? 'block' : 'none',
            width: '100%',
            height: 'auto',
            objectFit: 'fill',
          }}
        />
      )}

      {!loaded && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: 0.5 }}>
          {!errored
            ? <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, borderColor: fallbackColor }} />
            : <BookOpen size={24} color={fallbackColor} />
          }
        </div>
      )}
    </div>
  )
}
