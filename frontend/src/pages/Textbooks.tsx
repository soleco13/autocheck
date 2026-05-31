import { useState, FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, Plus, Upload, X, FileText } from 'lucide-react'
import { getTextbooks, createTextbook, uploadTextbookContent } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { toast } from '../components/Toast'

const SUBJECTS = [
  { code: 'А',  name: 'Алгебра' },
  { code: 'Г',  name: 'Геометрия' },
  { code: 'АЯ', name: 'Английский язык' },
  { code: 'Р',  name: 'Русский язык' },
  { code: 'Л',  name: 'Литература' },
  { code: 'Ф',  name: 'Физика' },
  { code: 'Х',  name: 'Химия' },
  { code: 'Б',  name: 'Биология' },
  { code: 'И',  name: 'История' },
  { code: 'О',  name: 'Обществознание' },
]

export default function Textbooks() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ grade: 6, subjectCode: 'АЯ', title: '', author: '' })
  const [uploading, setUploading] = useState<string | null>(null)
  const [contentText, setContentText] = useState('')
  const [selectedTextbook, setSelectedTextbook] = useState<string | null>(null)

  const { data: textbooks = [], isLoading } = useQuery({
    queryKey: ['textbooks'],
    queryFn: getTextbooks,
  })

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
    } finally {
      setSaving(false)
    }
  }

  const handleUploadContent = async (textbookId: string) => {
    if (!contentText.trim()) return
    setUploading(textbookId)
    try {
      await uploadTextbookContent(textbookId, [
        { title: 'Основное содержание', content: contentText, position: 0 },
      ])
      qc.invalidateQueries({ queryKey: ['textbooks'] })
      setContentText('')
      setSelectedTextbook(null)
      toast.success('Содержимое загружено')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Ошибка загрузки')
    } finally {
      setUploading(null)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Учебники</h1>
          {!isLoading && (
            <p className="page-subtitle">{(textbooks as any[]).length} учебников</p>
          )}
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className={`btn ${showForm ? 'btn-secondary' : 'btn-primary'}`}
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Отмена' : 'Добавить учебник'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card p-6 mb-5" style={{ borderColor: 'var(--c-primary-muted)' }}>
          <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Новый учебник</h2>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--c-text-2)' }}>
                  Класс
                </label>
                <select
                  value={form.grade}
                  onChange={e => setForm(f => ({ ...f, grade: Number(e.target.value) }))}
                  className="input"
                >
                  {Array.from({ length: 11 }, (_, i) => i + 1).map(g => (
                    <option key={g} value={g}>{g} класс</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--c-text-2)' }}>
                  Предмет
                </label>
                <select
                  value={form.subjectCode}
                  onChange={e => setForm(f => ({ ...f, subjectCode: e.target.value }))}
                  className="input"
                >
                  {SUBJECTS.map(s => (
                    <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--c-text-2)' }}>
                  Название *
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  required
                  className="input"
                  placeholder="Английский язык. 6 класс"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--c-text-2)' }}>
                  Автор
                </label>
                <input
                  type="text"
                  value={form.author}
                  onChange={e => setForm(f => ({ ...f, author: e.target.value }))}
                  className="input"
                  placeholder="Афанасьева О.В."
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={saving} className="btn btn-primary">
                {saving ? <><span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />Сохранение...</> : 'Создать учебник'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">
                Отмена
              </button>
            </div>
          </form>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-5">
              <Skeleton height={16} width="50%" />
              <div style={{ marginTop: 8 }}><Skeleton height={13} width="35%" /></div>
            </div>
          ))}
        </div>
      ) : (textbooks as any[]).length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><BookMarked size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Учебники не загружены</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
            Добавьте учебник для ИИ-проверки
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(textbooks as any[]).map((tb: any) => (
            <div key={tb.id} className="card p-5">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: 'var(--c-primary-light)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <BookMarked size={18} color="var(--c-primary)" />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{tb.title}</p>
                    <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--c-text-2)' }}>
                      {tb.grade} класс · {tb.subject_name} ({tb.subject_code})
                      {tb.author && ` · ${tb.author}`}
                    </p>
                    <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>
                      {tb.chunks_count || 0} фрагментов загружено
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTextbook(selectedTextbook === tb.id ? null : tb.id)}
                  className="btn btn-secondary btn-sm"
                >
                  <Upload size={13} />
                  Загрузить текст
                </button>
              </div>

              {selectedTextbook === tb.id && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--c-border-solid)' }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--c-text-2)' }}>
                    Вставьте текст учебника (можно скопировать из PDF)
                  </label>
                  <textarea
                    value={contentText}
                    onChange={e => setContentText(e.target.value)}
                    rows={8}
                    className="input"
                    placeholder="Вставьте текст учебника здесь..."
                    style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => handleUploadContent(tb.id)}
                      disabled={uploading === tb.id || !contentText.trim()}
                      className="btn btn-primary"
                    >
                      {uploading === tb.id
                        ? <><span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />Загрузка...</>
                        : <><FileText size={13} />Загрузить</>
                      }
                    </button>
                    <button
                      onClick={() => setSelectedTextbook(null)}
                      className="btn btn-secondary"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
