import { useState, useRef, FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, Plus, Upload, X, FileText, Search, Book } from 'lucide-react'
import { getTextbooks, createTextbook, uploadTextbookContent } from '../api/client'
import { toast } from '../components/Toast'

const SUBJECTS = [
  { code: 'А',  name: 'Алгебра',         color: '#1d4ed8' },
  { code: 'Г',  name: 'Геометрия',       color: '#0d9488' },
  { code: 'АЯ', name: 'Английский язык', color: '#7c3aed' },
  { code: 'Р',  name: 'Русский язык',    color: '#d97706' },
  { code: 'Л',  name: 'Литература',      color: '#db2777' },
  { code: 'Ф',  name: 'Физика',          color: '#0891b2' },
  { code: 'Х',  name: 'Химия',           color: '#16a34a' },
  { code: 'Б',  name: 'Биология',        color: '#15803d' },
  { code: 'И',  name: 'История',         color: '#dc2626' },
  { code: 'О',  name: 'Обществознание',  color: '#ca8a04' },
]

function getSubjectColor(code: string) {
  return SUBJECTS.find(s => s.code === code)?.color ?? '#475467'
}

export default function Textbooks() {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ grade: 6, subjectCode: 'АЯ', title: '', author: '' })
  const [uploading, setUploading] = useState<string | null>(null)
  const [contentText, setContentText] = useState('')
  const [selectedTextbook, setSelectedTextbook] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [search, setSearch] = useState('')

  const { data: textbooks = [], isLoading } = useQuery({
    queryKey: ['textbooks'],
    queryFn: getTextbooks,
  })

  const filtered = (textbooks as any[]).filter(tb =>
    !search || tb.title?.toLowerCase().includes(search.toLowerCase()) || tb.author?.toLowerCase().includes(search.toLowerCase())
  )

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const subj = SUBJECTS.find(s => s.code === form.subjectCode)
      await createTextbook({ ...form, subjectName: subj?.name || form.subjectCode })
      qc.invalidateQueries({ queryKey: ['textbooks'] })
      setShowForm(false)
      setForm({ grade: 6, subjectCode: 'АЯ', title: '', author: '' })
      toast.success('Учебник добавлен')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка сохранения')
    } finally { setSaving(false) }
  }

  const handleUploadContent = async (textbookId: string) => {
    if (!contentText.trim()) return
    setUploading(textbookId)
    try {
      await uploadTextbookContent(textbookId, [{ title: 'Основное содержание', content: contentText, position: 0 }])
      qc.invalidateQueries({ queryKey: ['textbooks'] })
      setContentText('')
      setSelectedTextbook(null)
      toast.success('Содержимое загружено')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка загрузки')
    } finally { setUploading(null) }
  }

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Учебники</h1>
          <p className="page-subtitle">Загруженные учебники для эталонных ответов ИИ</p>
        </div>
        <button onClick={() => setShowForm(v => !v)} className={`btn ${showForm ? 'btn-secondary' : 'btn-primary'}`}>
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Отмена' : 'Добавить учебник'}
        </button>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); toast('Для загрузки PDF заполните форму') }}
        onClick={() => { if (!showForm) setShowForm(true) }}
        style={{
          border: `2px dashed ${dragging ? 'var(--c-primary)' : 'var(--c-border-solid)'}`,
          background: dragging ? 'var(--c-primary-light)' : 'var(--c-surface)',
          borderRadius: 16, padding: '36px 24px', textAlign: 'center', cursor: 'pointer',
          transition: 'all 0.18s', marginBottom: 18,
        }}>
        <input ref={inputRef} type="file" accept=".pdf,.txt" hidden onChange={e => { if (e.target.files?.[0]) toast('Выберите учебник из списка для загрузки содержимого'); e.target.value = '' }} />
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--c-primary-light)', color: 'var(--c-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
          <Upload size={26} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Добавьте учебник</div>
        <div style={{ fontSize: 14, color: 'var(--c-text-3)', marginTop: 5 }}>Нажмите, чтобы открыть форму создания</div>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card card-pad" style={{ marginBottom: 18, border: '1px solid var(--c-primary-muted)', background: 'var(--c-primary-light)' }}>
          <h2 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>Новый учебник</h2>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 5, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Класс</label>
                <select value={form.grade} onChange={e => setForm(f => ({ ...f, grade: Number(e.target.value) }))} className="input">
                  {Array.from({ length: 11 }, (_, i) => i + 1).map(g => <option key={g} value={g}>{g} класс</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 5, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Предмет</label>
                <select value={form.subjectCode} onChange={e => setForm(f => ({ ...f, subjectCode: e.target.value }))} className="input">
                  {SUBJECTS.map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 5, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Название *</label>
                <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required className="input" placeholder="Английский язык. 6 класс" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 5, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Автор</label>
                <input type="text" value={form.author} onChange={e => setForm(f => ({ ...f, author: e.target.value }))} className="input" placeholder="Афанасьева О.В." />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={saving} className="btn btn-primary">
                {saving ? <><span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> Сохранение...</> : 'Создать учебник'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Отмена</button>
            </div>
          </form>
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
          <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>Учебников: {filtered.length}</div>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card card-pad">
              <div className="skeleton" style={{ width: 60, height: 80, borderRadius: 8, marginBottom: 14 }} />
              <div className="skeleton" style={{ width: '80%', height: 15, borderRadius: 8, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '50%', height: 13, borderRadius: 8 }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><BookMarked size={40} strokeWidth={1.5} /></div>
          <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>Учебников не найдено</p>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-3)' }}>Добавьте учебник для улучшения точности ИИ-проверки</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {filtered.map((tb: any) => {
            const color = getSubjectColor(tb.subject_code || '')
            return (
              <div key={tb.id} className="card card-pad">
                <div style={{ display: 'flex', gap: 16 }}>
                  {/* Cover */}
                  <div style={{
                    width: 60, height: 80, borderRadius: 8, flexShrink: 0,
                    background: `repeating-linear-gradient(135deg, ${color}22, ${color}22 6px, ${color}11 6px, ${color}11 12px)`,
                    border: `1px solid ${color}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Book size={24} color={color} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.35 }}>{tb.title}</div>
                    {tb.author && <div style={{ fontSize: 13, color: 'var(--c-text-3)', marginTop: 3 }}>{tb.author}</div>}
                    <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color, background: color + '14', padding: '3px 10px', borderRadius: 99 }}>
                        {tb.subject_name || tb.subject_code}
                      </span>
                      {tb.grade && <span className="badge badge-gray">{tb.grade} кл.</span>}
                      <span className="badge badge-green">
                        <span className="dot" style={{ background: '#16a34a' }} />
                        {tb.chunks_count || 0} фр.
                      </span>
                    </div>
                  </div>
                </div>

                {/* Upload content toggle */}
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--c-border-solid)' }}>
                  <button className="btn btn-secondary btn-sm" style={{ width: '100%' }}
                    onClick={() => setSelectedTextbook(selectedTextbook === tb.id ? null : tb.id)}>
                    <Upload size={13} /> Загрузить содержимое
                  </button>
                </div>

                {selectedTextbook === tb.id && (
                  <div style={{ marginTop: 14 }}>
                    <textarea value={contentText} onChange={e => setContentText(e.target.value)} rows={6} className="input"
                      placeholder="Вставьте текст учебника здесь…"
                      style={{ resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.6 }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button onClick={() => handleUploadContent(tb.id)} disabled={uploading === tb.id || !contentText.trim()} className="btn btn-primary btn-sm">
                        {uploading === tb.id ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Загрузка...</> : <><FileText size={13} /> Загрузить</>}
                      </button>
                      <button onClick={() => setSelectedTextbook(null)} className="btn btn-ghost btn-sm">Отмена</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
