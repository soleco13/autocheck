import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookMarked, Upload, X, Search, Book, Trash2,
  CheckCircle, AlertTriangle, Clock, FileText, Layers, RefreshCw,
} from 'lucide-react'
import { getTextbooks, uploadTextbookPdf, getTextbookStatus, deleteTextbook, reindexTextbook } from '../api/client'
import { toast } from '../components/Toast'
import PdfCover from '../components/PdfCover'

// Коды взяты из реальных control_sheets платформы (поле subject_code)
const SUBJECTS = [
  { code: 'РЯ',   name: 'Русский язык',              color: '#d97706' },
  { code: 'Л',    name: 'Литература',                 color: '#db2777' },
  { code: 'ЛЧ',   name: 'Литературное чтение',        color: '#be185d' },
  { code: 'АЯ',   name: 'Английский язык',            color: '#7c3aed' },
  { code: 'МА',   name: 'Математика',                 color: '#2563eb' },
  { code: 'А',    name: 'Алгебра',                    color: '#1d4ed8' },
  { code: 'Г',    name: 'Геометрия',                  color: '#0d9488' },
  { code: 'ВИС',  name: 'Вероятность и статистика',   color: '#0891b2' },
  { code: 'ГЕО',  name: 'География',                  color: '#16a34a' },
  { code: 'ИС',   name: 'История',                    color: '#dc2626' },
  { code: 'О',    name: 'Обществознание',             color: '#ca8a04' },
  { code: 'ОДНКР',name: 'ОДНКНР',                     color: '#b45309' },
  { code: 'ОМ',   name: 'Окружающий мир',             color: '#15803d' },
  { code: 'Б',    name: 'Биология',                   color: '#166534' },
  { code: 'Ф',    name: 'Физика',                     color: '#0369a1' },
  { code: 'Х',    name: 'Химия',                      color: '#15803d' },
  { code: 'ИНФ',  name: 'Информатика',                color: '#6d28d9' },
  { code: 'ИЗО',  name: 'Изобразительное искусство',  color: '#9333ea' },
  { code: 'МУЗ',  name: 'Музыка',                     color: '#c026d3' },
  { code: 'ТЕХ',  name: 'Технология',                 color: '#475569' },
  { code: 'ФК',   name: 'Физическая культура',        color: '#0f766e' },
]

const LANG_OPTIONS = [
  { value: 'ru',    label: 'Русский' },
  { value: 'en',    label: 'Английский' },
  { value: 'mixed', label: 'Оба языка' },
]

// Шаги в порядке выполнения (соответствует rag-indexer.ts setProgress вызовам)
const STEP_ORDER = ['parsing', 'chunking', 'saving'] as const
type Step = typeof STEP_ORDER[number]

const STEP_LABELS: Record<Step | 'done', string> = {
  parsing:  'Извлечение текста',
  chunking: 'Нарезка на фрагменты',
  saving:   'Сохранение в базу',
  done:     'Готово',
}

function getSubjectColor(code: string) {
  return SUBJECTS.find(s => s.code === code)?.color ?? '#475467'
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

// ── Progress card for a textbook being indexed ────────────────────────────────
function IndexingCard({ doc, onReady }: { doc: any; onReady: () => void }) {
  const [status, setStatus] = useState<any>(doc)

  useEffect(() => {
    if (status.status === 'ready' || status.status === 'error') return

    const poll = setInterval(async () => {
      try {
        const s = await getTextbookStatus(doc.id)
        setStatus(s)
        if (s.status === 'ready' || s.status === 'error') {
          clearInterval(poll)
          onReady()
        }
      } catch { /* keep polling */ }
    }, 1500)

    return () => clearInterval(poll)
  }, [doc.id, status.status])

  const pct: number = status.progress_pct ?? 0
  const step: string = STEP_LABELS[status.progress_step as Step] ?? 'Подготовка...'
  const isError = status.status === 'error'

  const color = isError ? '#dc2626' : '#1d4ed8'
  const bg    = isError ? '#fef2f2' : '#eff4ff'

  return (
    <div className="card card-pad" style={{ border: `1px solid ${isError ? '#fecaca' : 'var(--c-primary-muted)'}`, background: bg }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: color + '20', color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {isError ? <AlertTriangle size={18} /> : <Layers size={18} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginTop: 2 }}>{doc.filename}</div>
        </div>
      </div>

      {isError ? (
        <div style={{ fontSize: 13, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
          {status.error_msg || 'Ошибка обработки'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>{step}</span>
            <span style={{ fontSize: 12.5, color, fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ height: 6, background: '#dbeafe', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: color,
              borderRadius: 99, transition: 'width 0.6s ease',
            }} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {STEP_ORDER.map(s => {
              const curIdx = STEP_ORDER.indexOf(status.progress_step as Step)
              const thisIdx = STEP_ORDER.indexOf(s)
              const done = curIdx > thisIdx || status.status === 'ready'
              const active = curIdx === thisIdx
              return (
                <span key={s} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
                  background: done ? '#dcfce7' : active ? '#dbeafe' : 'var(--c-surface-2)',
                  color: done ? '#16a34a' : active ? '#1d4ed8' : 'var(--c-text-3)',
                }}>
                  {done ? '✓ ' : ''}{STEP_LABELS[s]}
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Upload form (inline, shown after file selected) ───────────────────────────
function UploadForm({ file, onCancel, onSuccess }: {
  file: File
  onCancel: () => void
  onSuccess: (doc: any) => void
}) {
  const [form, setForm] = useState({
    title: file.name.replace(/\.pdf$/i, '').replace(/[_-]/g, ' '),
    author: '',
    subjectCode: 'АЯ',
    grade: '6',
    lang: 'ru',
  })
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) { toast.error('Введите название учебника'); return }

    setUploading(true)
    setUploadPct(0)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', form.title.trim())
    fd.append('author', form.author.trim())
    fd.append('subjectCode', form.subjectCode)
    fd.append('grade', form.grade)
    fd.append('lang', form.lang)

    // Simulate upload progress (axios doesn't expose it easily here)
    const prog = setInterval(() => setUploadPct(p => Math.min(p + 15, 90)), 200)
    try {
      const result = await uploadTextbookPdf(fd)
      clearInterval(prog); setUploadPct(100)
      toast.success('Файл загружен, обработка начата')
      onSuccess({ id: result.id, title: form.title.trim(), filename: file.name, status: 'pending', progress_step: null, progress_pct: 0 })
    } catch (err: any) {
      clearInterval(prog)
      toast.error(err.response?.data?.error || 'Ошибка загрузки')
    } finally {
      setUploading(false)
    }
  }

  const subj = SUBJECTS.find(s => s.code === form.subjectCode)

  return (
    <div className="card card-pad" style={{ border: '1px solid var(--c-primary-muted)', background: 'var(--c-primary-light)', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--c-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <FileText size={18} />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{file.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--c-text-3)' }}>{formatBytes(file.size)} · PDF</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={uploading}>
          <X size={14} />
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Название *</label>
            <input className="input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required disabled={uploading} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Автор</label>
            <input className="input" value={form.author} onChange={e => setForm(f => ({ ...f, author: e.target.value }))} placeholder="Иванов И.И." disabled={uploading} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Предмет</label>
            <select className="input" value={form.subjectCode} onChange={e => setForm(f => ({ ...f, subjectCode: e.target.value }))} disabled={uploading}>
              {SUBJECTS.map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Класс</label>
            <select className="input" value={form.grade} onChange={e => setForm(f => ({ ...f, grade: e.target.value }))} disabled={uploading}>
              {Array.from({ length: 11 }, (_, i) => i + 1).map(g => <option key={g} value={String(g)}>{g} класс</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, marginBottom: 4, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Язык</label>
            <select className="input" value={form.lang} onChange={e => setForm(f => ({ ...f, lang: e.target.value }))} disabled={uploading}>
              {LANG_OPTIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
        </div>

        {uploading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12.5, color: 'var(--c-primary)', fontWeight: 600 }}>Загрузка файла...</span>
              <span style={{ fontSize: 12.5, color: 'var(--c-primary)', fontWeight: 700 }}>{uploadPct}%</span>
            </div>
            <div style={{ height: 6, background: 'var(--c-primary-muted)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${uploadPct}%`, background: 'var(--c-primary)', borderRadius: 99, transition: 'width 0.3s ease' }} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={uploading}>
            {uploading
              ? <><span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> Загружается...</>
              : <><Upload size={14} /> Загрузить и обработать</>
            }
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={uploading}>Отмена</button>
          {subj && (
            <span style={{ marginLeft: 'auto', fontSize: 12.5, color: subj.color, fontWeight: 600, background: subj.color + '15', padding: '3px 10px', borderRadius: 99 }}>
              {subj.name} · {form.grade} кл.
            </span>
          )}
        </div>
      </form>
    </div>
  )
}

// ── Textbook card (ready or error) ────────────────────────────────────────────
function TextbookCard({ tb, onDelete, onReindex }: { tb: any; onDelete: () => void; onReindex: (doc: any) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const reindexRef = useRef<HTMLInputElement>(null)
  const color = getSubjectColor(tb.subject_code || '')

  const langLabel: Record<string, string> = { ru: 'RU', en: 'EN', mixed: 'RU+EN' }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteTextbook(tb.id)
      toast.success('Учебник удалён')
      onDelete()
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Ошибка удаления')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div className="card card-pad" style={{ border: tb.status === 'error' ? '1px solid #fecaca' : '1px solid var(--c-border-solid)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{
          width: 68, height: 96, borderRadius: 6, flexShrink: 0,
          border: `1px solid ${color}33`,
          overflow: 'hidden',
          boxShadow: '2px 3px 8px rgba(0,0,0,0.12)',
        }}>
          {tb.status === 'ready'
            ? <PdfCover documentId={tb.id} fallbackColor={color} />
            : <div style={{ width: '100%', height: '100%', background: `repeating-linear-gradient(135deg,${color}22,${color}22 6px,${color}11 6px,${color}11 12px)`, display:'flex',alignItems:'center',justifyContent:'center' }}>
                <Book size={22} color={color} />
              </div>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tb.title}</div>
          {tb.author && <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginTop: 2 }}>{tb.author}</div>}
          <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color, background: color + '14', padding: '2px 8px', borderRadius: 99 }}>
              {SUBJECTS.find(s => s.code === tb.subject_code)?.name || tb.subject_code}
            </span>
            {tb.grade && <span className="badge badge-gray">{tb.grade} кл.</span>}
            {tb.lang && <span className="badge badge-gray" style={{ fontFamily: 'monospace' }}>{langLabel[tb.lang] || tb.lang}</span>}

            {tb.status === 'ready' && (
              <span className="badge badge-green" style={{ marginLeft: 'auto' }}>
                <CheckCircle size={11} /> {tb.chunk_count} фр.
              </span>
            )}
            {tb.status === 'error' && (
              <span className="badge" style={{ background: '#fef2f2', color: '#dc2626', marginLeft: 'auto' }}>
                <AlertTriangle size={11} /> Ошибка
              </span>
            )}
          </div>
          {tb.file_size_bytes > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--c-text-3)', marginTop: 4 }}>
              {formatBytes(tb.file_size_bytes)}
            </div>
          )}
          {tb.status === 'error' && tb.error_msg && (
            <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6, lineHeight: 1.4 }}>{tb.error_msg}</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--c-border-solid)' }}>
        {confirmDelete ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>Удалить учебник?</span>
            <button className="btn btn-sm" onClick={handleDelete} disabled={deleting}
              style={{ background: '#dc2626', color: '#fff', border: 'none' }}>
              {deleting ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : 'Удалить'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>Отмена</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" title="Переиндексировать с новым файлом"
              onClick={() => reindexRef.current?.click()}
              style={{ color: 'var(--c-text-3)' }}>
              <RefreshCw size={13} /> Переиндексировать
            </button>
            <input ref={reindexRef} type="file" accept=".pdf" hidden onChange={async e => {
              const file = e.target.files?.[0]; e.target.value = ''
              if (!file) return
              try {
                const result = await reindexTextbook(tb.id, file)
                toast.success('Переиндексирование запущено')
                onReindex({ ...tb, status: 'pending', progress_pct: 0, progress_step: null, id: result.id })
              } catch (err: any) { toast.error(err.response?.data?.error || 'Ошибка') }
            }} />
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}
              style={{ color: 'var(--c-text-3)' }}>
              <Trash2 size={13} /> Удалить
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Textbooks() {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [indexingDocs, setIndexingDocs] = useState<any[]>([])
  const [search, setSearch] = useState('')

  const { data: textbooks = [], isLoading } = useQuery({
    queryKey: ['textbooks'],
    queryFn: getTextbooks,
  })

  // On mount: pick up any docs still in processing/pending state from DB
  useEffect(() => {
    const inProgress = (textbooks as any[]).filter(
      tb => tb.status === 'pending' || tb.status === 'processing'
    )
    if (inProgress.length > 0) {
      setIndexingDocs(prev => {
        const existingIds = new Set(prev.map((d: any) => d.id))
        return [...prev, ...inProgress.filter((d: any) => !existingIds.has(d.id))]
      })
    }
  }, [textbooks])

  const filtered = (textbooks as any[]).filter(
    tb => (tb.status === 'ready' || tb.status === 'error') &&
      (!search || tb.title?.toLowerCase().includes(search.toLowerCase()) ||
       tb.author?.toLowerCase().includes(search.toLowerCase()))
  )

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Поддерживаются только PDF файлы')
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error('Файл слишком большой (макс. 50 МБ)')
      return
    }
    setPendingFile(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  const handleUploadSuccess = (doc: any) => {
    setPendingFile(null)
    setIndexingDocs(prev => [doc, ...prev])
  }

  const handleIndexingReady = () => {
    qc.invalidateQueries({ queryKey: ['textbooks'] })
  }

  const handleIndexingDone = (docId: string) => {
    setIndexingDocs(prev => prev.filter(d => d.id !== docId))
    qc.invalidateQueries({ queryKey: ['textbooks'] })
  }

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Учебники</h1>
          <p className="page-subtitle">Загрузите PDF-учебники для RAG-проверки — ИИ будет опираться только на них</p>
        </div>
      </div>

      {/* Upload form */}
      {pendingFile && (
        <UploadForm
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onSuccess={handleUploadSuccess}
        />
      )}

      {/* Dropzone */}
      {!pendingFile && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? 'var(--c-primary)' : 'var(--c-border-solid)'}`,
            background: dragging ? 'var(--c-primary-light)' : 'var(--c-surface)',
            borderRadius: 16, padding: '36px 24px', textAlign: 'center',
            cursor: 'pointer', transition: 'all 0.18s', marginBottom: 18,
          }}
        >
          <input ref={inputRef} type="file" accept=".pdf" hidden onChange={handleInputChange} />
          <div style={{ width: 56, height: 56, borderRadius: 16, background: dragging ? 'var(--c-primary)' : 'var(--c-primary-light)', color: dragging ? '#fff' : 'var(--c-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', transition: 'all 0.18s' }}>
            <Upload size={26} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Перетащите PDF или нажмите для выбора</div>
          <div style={{ fontSize: 13.5, color: 'var(--c-text-3)', marginTop: 5 }}>
            Текстовый PDF · до 50 МБ · обрабатывается автоматически
          </div>
        </div>
      )}

      {/* Indexing cards */}
      {indexingDocs.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--c-text-3)', marginBottom: 10 }}>
            <Clock size={12} style={{ marginRight: 5, verticalAlign: 'middle' }} />
            Обрабатываются ({indexingDocs.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {indexingDocs.map(doc => (
              <IndexingCard
                key={doc.id}
                doc={doc}
                onReady={() => handleIndexingDone(doc.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="card" style={{ padding: 14, marginBottom: 18 }}>
        <div className="filter-bar">
          <div className="search-wrap" style={{ flex: 1, minWidth: 240 }}>
            <span className="search-icon"><Search size={17} /></span>
            <input className="input input-search" placeholder="Поиск по названию или автору…" value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button className="search-clear" onClick={() => setSearch('')}><X size={15} /></button>}
          </div>
          <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>
            Учебников: {filtered.length}
          </div>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card card-pad">
              <div className="skeleton" style={{ width: 56, height: 72, borderRadius: 8, marginBottom: 14 }} />
              <div className="skeleton" style={{ width: '80%', height: 15, borderRadius: 8, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '50%', height: 13, borderRadius: 8 }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 && indexingDocs.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><BookMarked size={40} strokeWidth={1.5} /></div>
          <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>Учебников нет</p>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-3)' }}>
            Загрузите PDF-учебник — ИИ будет проверять ответы только на основе его содержимого
          </p>
        </div>
      ) : filtered.length === 0 ? null : (
        <div className="grid-3">
          {filtered.map((tb: any) => (
            <TextbookCard
              key={tb.id}
              tb={tb}
              onDelete={() => qc.invalidateQueries({ queryKey: ['textbooks'] })}
              onReindex={(doc) => {
                setIndexingDocs(prev => [doc, ...prev.filter(d => d.id !== doc.id)])
                qc.invalidateQueries({ queryKey: ['textbooks'] })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
