import { useState, useRef, useMemo } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, CheckCircle, XCircle, AlertCircle, AlertTriangle,
  Clock, Pencil, BookOpen, MessageSquare, ChevronDown, ChevronRight,
  Award, TrendingUp, Eye, Sparkles, Filter,
} from 'lucide-react'
import { getCheckReport, overrideAnswerScore } from '../api/client'
import { toast } from '../components/Toast'
import { MathText } from '../components/MathText'
import { Donut } from '../components/Charts'

const TYPE_LABEL: Record<string, string> = {
  check_value: 'Число', open_answer: 'Открытый ответ', matches: 'Соответствие',
  input: 'Ввод', quiz: 'Тест', fill_blanks: 'Пропуски',
}

const ATTENTION = ['incorrect', 'partial', 'manual_required']

const R_META: Record<string, { label: string; color: string; accent: string; bg: string; icon: React.ReactNode; cell: string; cellText: string; hollow: boolean }> = {
  correct:         { label: 'Верно',             color: '#15803d', accent: '#22c55e', bg: '#f0fdf4', icon: <CheckCircle size={16} />, cell: '#16a34a', cellText: '#fff', hollow: false },
  partial:         { label: 'Частично верно',    color: '#b45309', accent: '#f59e0b', bg: '#fffaeb', icon: <AlertCircle size={16} />, cell: '#f59e0b', cellText: '#fff', hollow: false },
  incorrect:       { label: 'Неверно',           color: '#dc2626', accent: '#ef4444', bg: '#fef2f2', icon: <XCircle size={16} />, cell: '#ef4444', cellText: '#fff', hollow: false },
  manual_required: { label: 'Проверьте вручную', color: '#b45309', accent: '#fb923c', bg: '#fff7ed', icon: <Eye size={16} />, cell: '#fff', cellText: '#c2410c', hollow: true },
  pending:         { label: 'Ожидание',          color: '#94a3b8', accent: '#94a3b8', bg: '#f8fafc', icon: <Clock size={16} />, cell: '#94a3b8', cellText: '#fff', hollow: false },
  error:           { label: 'Ошибка',            color: '#dc2626', accent: '#ef4444', bg: '#fef2f2', icon: <XCircle size={16} />, cell: '#ef4444', cellText: '#fff', hollow: false },
}

function getR(status: string) { return R_META[status] ?? R_META.pending }

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

function verdictFor(pct: number, attentionCount: number) {
  if (pct >= 85) return { color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', icon: <Award size={20} color="#16a34a" />, title: 'Отличный результат', sub: 'Тема усвоена уверенно' }
  if (pct >= 70) return { color: '#1d4ed8', bg: '#eff4ff', border: '#c7d7fe', icon: <TrendingUp size={20} color="#1d4ed8" />, title: 'Хороший результат', sub: `${attentionCount} ${plural(attentionCount, 'задание', 'задания', 'заданий')} требуют внимания` }
  if (pct >= 50) return { color: '#d97706', bg: '#fffaeb', border: '#fde68a', icon: <AlertCircle size={20} color="#d97706" />, title: 'Удовлетворительно', sub: 'Тему стоит закрепить' }
  return { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', icon: <AlertTriangle size={20} color="#dc2626" />, title: 'Тема не усвоена', sub: 'Требуется повторное объяснение' }
}

function GradePill({ grade }: { grade: number | null }) {
  if (grade == null) return null
  const color = grade >= 5 ? '#16a34a' : grade >= 4 ? '#1d4ed8' : grade >= 3 ? '#d97706' : '#dc2626'
  const bg = grade >= 5 ? '#f0fdf4' : grade >= 4 ? '#eff4ff' : grade >= 3 ? '#fffaeb' : '#fef2f2'
  return (
    <div style={{ width: 56, height: 56, borderRadius: 14, background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 28, flexShrink: 0 }}>
      {grade}
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }} className="fade-in">
      <div className="skeleton" style={{ width: 160, height: 14, marginBottom: 20, borderRadius: 8 }} />
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
          <div className="skeleton" style={{ width: 132, height: 132, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ width: 120, height: 20, borderRadius: 8, marginBottom: 12 }} />
            <div className="skeleton" style={{ width: '55%', height: 26, borderRadius: 8, marginBottom: 14 }} />
            <div className="skeleton" style={{ width: '40%', height: 14, borderRadius: 8 }} />
          </div>
          <div className="skeleton" style={{ width: 200, height: 72, borderRadius: 14 }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: 12, borderRadius: 99, marginTop: 24, marginBottom: 14 }} />
        <div style={{ display: 'flex', gap: 7 }}>
          {Array.from({ length: 7 }).map((_, i) => <div key={i} className="skeleton" style={{ width: 34, height: 34, borderRadius: 9 }} />)}
        </div>
      </div>
      {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ width: '100%', height: 70, borderRadius: 14, marginBottom: 12 }} />)}
    </div>
  )
}

function FilterChip({ active, onClick, label, n, tone, icon }: {
  active: boolean; onClick: () => void; label: string; n: number; tone?: string; icon?: React.ReactNode
}) {
  const toneColor = tone === 'danger' ? '#dc2626' : tone === 'success' ? '#16a34a' : 'var(--c-primary)'
  return (
    <button onClick={onClick} className="chip" style={{
      background: active ? toneColor : 'var(--c-surface)',
      borderColor: active ? toneColor : 'var(--c-border-solid)',
      color: active ? '#fff' : 'var(--c-text-2)',
    }}>
      {icon}
      {label}
      <span style={{ fontWeight: 750, fontSize: 12, padding: '1px 7px', borderRadius: 99, background: active ? 'rgba(255,255,255,0.22)' : 'var(--c-surface-3)', color: active ? '#fff' : 'var(--c-text-2)' }}>{n}</span>
    </button>
  )
}

function TaskCard({ ans, globalIdx, expanded, onToggle, flash, overrides, setScore, qc, sessionId }: {
  ans: any; globalIdx: number; expanded: boolean; onToggle: () => void; flash: boolean
  overrides: Record<string, number>; setScore: (id: string, s: number) => void
  qc: any; sessionId: string
}) {
  const m = getR(ans.status)
  const effectiveScore = overrides[ans.id] != null ? overrides[ans.id] : (ans.teacher_override_score ?? ans.score ?? 0)
  const maxScore = ans.task_max_score || 1
  const structured = ans.student_answer_structured

  return (
    <div className={`task-card ${flash ? 'card-flash' : ''}`}
      style={{ display: 'flex', background: 'var(--c-surface)', border: '1px solid var(--c-border-solid)', borderRadius: 14, overflow: 'hidden' }}>

      {/* Grading-margin rail */}
      <div onClick={onToggle} style={{
        width: 52, flexShrink: 0, cursor: 'pointer', background: m.bg,
        borderRight: `1px solid ${m.accent}33`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
      }}>
        <span style={{
          width: 30, height: 30, borderRadius: '50%', background: '#fff',
          border: `1.5px solid ${m.accent}`, color: m.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{m.icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: m.color }}>{globalIdx + 1}</span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 750, color: m.color }}>{m.label}</span>
              {ans.task_type && (
                <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--c-text-3)', background: 'var(--c-surface-3)', padding: '2px 8px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {TYPE_LABEL[ans.task_type] || ans.task_type}
                </span>
              )}
              {(overrides[ans.id] != null || ans.teacher_override_at) && (
                <span style={{ fontSize: 11, color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Pencil size={10} /> скорр.</span>
              )}
            </div>
            {ans.question_text && (
              <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--c-text)', lineHeight: 1.4, whiteSpace: expanded ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <MathText>{ans.question_text}</MathText>
              </div>
            )}
          </div>
          {/* Stamped score pill */}
          <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'baseline', gap: 1, background: m.color, color: m.hollow ? '#c2410c' : '#fff', padding: '5px 11px', borderRadius: 9, fontWeight: 800, boxShadow: `0 2px 7px ${m.accent}55` }}>
            <span style={{ fontSize: 15 }}>{effectiveScore}</span><span style={{ fontSize: 12, opacity: 0.85 }}>/{maxScore}</span>
          </span>
          {expanded
            ? <ChevronDown size={18} color="var(--c-text-3)" style={{ flexShrink: 0, transform: 'rotate(180deg)', transition: 'transform 0.25s' }} />
            : <ChevronRight size={18} color="var(--c-text-3)" style={{ flexShrink: 0, transition: 'transform 0.25s' }} />}
        </div>

        <div className="collapser" style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}>
          <div className="collapser-inner">
            <div style={{ padding: '2px 16px 16px' }}>
              {/* QUIZ */}
              {ans.task_type === 'quiz' && structured?.allOptions && (
                <AnswerPanel label="Варианты ответа">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {structured.allOptions.map((opt: any, i: number) => {
                      let bg = '#f1f5f9', color = '#64748b', border = '1px solid #e2e8f0', icon: React.ReactNode = null
                      if (opt.isChecked && opt.isCorrect) { bg = '#dcfce7'; color = '#166534'; border = '1.5px solid #22c55e'; icon = <CheckCircle size={14} /> }
                      else if (opt.isChecked && !opt.isCorrect) { bg = '#fee2e2'; color = '#991b1b'; border = '1.5px solid #ef4444'; icon = <XCircle size={14} /> }
                      else if (!opt.isChecked && opt.isCorrect) { bg = '#fef9c3'; color = '#92400e'; border = '1.5px dashed #f59e0b'; icon = <AlertCircle size={14} /> }
                      return <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 10, fontSize: 14, fontWeight: 600, background: bg, color, border }}>{icon}<MathText>{opt.text}</MathText></span>
                    })}
                  </div>
                </AnswerPanel>
              )}

              {/* FILL_BLANKS */}
              {ans.task_type === 'fill_blanks' && structured?.items && (
                <AnswerPanel label="Заполнение пропусков">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {structured.items.map((item: any, i: number) => {
                      const ok = item.studentAnswer === item.correctAnswer
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, flexWrap: 'wrap' }}>
                          {ok ? <CheckCircle size={15} color="#22c55e" style={{ flexShrink: 0 }} /> : <XCircle size={15} color="#ef4444" style={{ flexShrink: 0 }} />}
                          <span style={{ color: 'var(--c-text-2)', minWidth: 200 }}><MathText>{item.questionText}</MathText></span>
                          <span style={{ fontWeight: 700, color: ok ? '#166534' : '#991b1b' }}><MathText>{item.studentAnswer || '(пусто)'}</MathText></span>
                          {!ok && item.correctAnswer && <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>→ <span style={{ color: '#16a34a', fontWeight: 600 }}>{item.correctAnswer}</span></span>}
                        </div>
                      )
                    })}
                  </div>
                </AnswerPanel>
              )}

              {/* MATCHES */}
              {ans.task_type === 'matches' && ans.student_answer && (
                <AnswerPanel label="Сопоставления">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ans.student_answer.split('\n').filter(Boolean).map((pair: string, i: number) => {
                      const [left, right] = pair.split(' → ')
                      return (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--c-primary-light)', border: '1px solid var(--c-primary-muted)', borderRadius: 10, padding: '5px 12px', fontSize: 14 }}>
                          <span style={{ fontWeight: 600 }}><MathText>{left}</MathText></span>
                          <span style={{ color: 'var(--c-primary)', fontWeight: 700 }}>→</span>
                          <span><MathText>{right || ''}</MathText></span>
                        </span>
                      )
                    })}
                  </div>
                </AnswerPanel>
              )}

              {/* GENERIC */}
              {!['quiz', 'fill_blanks', 'matches'].includes(ans.task_type) && (ans.student_answer || ans.task_reference_answer) && (
                <GenericAns status={ans.status} studentAnswer={ans.student_answer} reference={ans.task_reference_answer} />
              )}

              {/* AI feedback */}
              {ans.ai_feedback && (
                <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--c-surface-2)', border: '1px solid var(--c-border-solid)', borderRadius: 12, padding: '11px 13px' }}>
                  <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--c-teal-light)', color: 'var(--c-teal)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Sparkles size={14} />
                  </span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--c-teal)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Комментарий ИИ</div>
                    <p style={{ fontSize: 13.5, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}><MathText>{ans.ai_feedback}</MathText></p>
                  </div>
                </div>
              )}
              {ans.ai_teacher_note && (
                <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 12, padding: '11px 13px' }}>
                  <span style={{ width: 26, height: 26, borderRadius: 8, background: '#ffedd5', color: '#ea580c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Eye size={14} />
                  </span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#ea580c', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Нужна ручная проверка</div>
                    <p style={{ fontSize: 13.5, color: '#c2410c', lineHeight: 1.55, margin: 0 }}>{ans.ai_teacher_note}</p>
                  </div>
                </div>
              )}

              {/* Score override */}
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px dashed var(--c-border-solid)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: 'var(--c-text-2)', fontWeight: 650, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Pencil size={13} color="var(--c-text-3)" /> Выставить балл
                </span>
                <div style={{ display: 'flex', gap: 5 }}>
                  {Array.from({ length: maxScore + 1 }, (_, i) => i).map(sc => (
                    <button key={sc} onClick={e => { e.stopPropagation(); setScore(ans.id, sc) }} style={{
                      minWidth: 34, height: 34, padding: '0 6px', borderRadius: 9, cursor: 'pointer', fontWeight: 750, fontSize: 13.5,
                      background: effectiveScore === sc ? 'var(--c-primary)' : 'var(--c-surface)',
                      color: effectiveScore === sc ? '#fff' : 'var(--c-text-2)',
                      border: `1px solid ${effectiveScore === sc ? 'var(--c-primary)' : 'var(--c-border-solid)'}`,
                      boxShadow: effectiveScore === sc ? '0 2px 8px rgba(29,78,216,0.28)' : 'none', transition: 'all 0.14s',
                    }}>{sc}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AnswerPanel({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--c-border-solid)', borderRadius: 12, padding: '13px 15px', background: 'var(--c-surface-2)' }}>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 11 }}>{label}</div>}
      {children}
    </div>
  )
}

function GenericAns({ status, studentAnswer, reference }: { status: string; studentAnswer?: string; reference?: string }) {
  const correct = status === 'correct'
  const stacked = !!(studentAnswer && studentAnswer.length > 46)
  const stuColor = correct ? '#0f766e' : getR(status).color
  const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }

  return (
    <div style={{ border: '1px solid var(--c-border-solid)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', justifyContent: 'space-between', gap: stacked ? 7 : 16, padding: '12px 15px', background: correct ? '#f3fcf8' : 'var(--c-surface-2)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: stuColor, textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0 }}>
          Ответ ученика
        </span>
        <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--c-text)', lineHeight: 1.55, ...(stacked ? {} : mono) }}>
          {studentAnswer ? <MathText>{studentAnswer}</MathText> : <span style={{ color: 'var(--c-text-3)' }}>(нет ответа)</span>}
        </span>
      </div>
      {!correct && reference && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 15px' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--c-border-solid)' }} />
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--c-teal)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>→ как надо</span>
            <div style={{ flex: 1, height: 1, background: 'var(--c-border-solid)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', justifyContent: 'space-between', gap: stacked ? 7 : 16, padding: '12px 15px', background: 'var(--c-teal-light)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#0f766e', textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0 }}>
              Верный ответ
            </span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: '#0f766e', lineHeight: 1.55, ...(stacked ? {} : mono) }}>
              <MathText>{reference}</MathText>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

export default function Report() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<'all' | 'attention' | 'correct'>('all')
  const [flashId, setFlashId] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLElement | null>>({})

  const { data: report, isLoading } = useQuery({
    queryKey: ['report', sessionId],
    queryFn: () => getCheckReport(sessionId!),
  })

  const answers: any[] = useMemo(() => report?.answers ?? [], [report])

  // Initialize expanded with non-correct tasks once data loads
  if (!initialized && answers.length > 0) {
    setInitialized(true)
    setExpanded(new Set(answers.filter((a: any) => a.status !== 'correct').map((a: any) => a.id)))
  }

  const counts = useMemo(() => answers.reduce((a: Record<string, number>, t: any) => {
    a[t.status] = (a[t.status] || 0) + 1; return a
  }, {} as Record<string, number>), [answers])

  const attentionCount = answers.filter((a: any) => ATTENTION.includes(a.status)).length
  const correctCount = counts.correct || 0

  const pct = report?.percentage ? Math.round(Number(report.percentage)) : 0
  const barColor = pct >= 70 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#ef4444'
  const verdict = verdictFor(pct, attentionCount)

  const toggle = (id: string) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allExpanded = answers.length > 0 && expanded.size >= answers.length
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(answers.map((a: any) => a.id)))

  const jumpTo = (ans: any) => {
    setFilter('all')
    setExpanded(s => new Set(s).add(ans.id))
    setFlashId(ans.id)
    setTimeout(() => {
      const el = refs.current[ans.id]
      if (el) {
        const y = el.getBoundingClientRect().top + window.scrollY - 96
        window.scrollTo({ top: y, behavior: 'smooth' })
      }
    }, 60)
    setTimeout(() => setFlashId(null), 1200)
  }

  const setScore = async (answerId: string, score: number) => {
    setOverrides(o => ({ ...o, [answerId]: score }))
    try {
      await overrideAnswerScore(answerId, score)
      qc.invalidateQueries({ queryKey: ['report', sessionId] })
      toast.success('Балл обновлён')
    } catch {
      toast.error('Не удалось обновить балл')
    }
  }

  if (isLoading) return <ReportSkeleton />

  if (!report) {
    return (
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div className="card empty-state">
          <div className="empty-state-icon"><Filter size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Отчёт не найден</p>
        </div>
      </div>
    )
  }

  // Group answers by slide
  type SlideGroup = { slideNum: number | null; items: any[] }
  const slides: SlideGroup[] = []
  const slideMap = new Map<number | string, number>()
  answers.forEach((ans: any) => {
    const sn: number | null = ans.student_answer_structured?._slideNum ?? ans.slide_num ?? null
    const key = sn ?? '__none__'
    if (!slideMap.has(key)) { slideMap.set(key, slides.length); slides.push({ slideNum: sn, items: [] }) }
    slides[slideMap.get(key)!].items.push(ans)
  })
  slides.sort((a, b) => {
    if (a.slideNum === null) return 1
    if (b.slideNum === null) return -1
    return a.slideNum - b.slideNum
  })

  const visibleSlides = slides.map(s => ({
    ...s,
    items: s.items.filter(t =>
      filter === 'all' ? true : filter === 'attention' ? ATTENTION.includes(t.status) : t.status === 'correct'
    ),
  })).filter(s => s.items.length > 0)

  const initials = (report.student_name || '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('')

  return (
    <div className="fade-in" style={{ width: '100%' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>

        {/* Breadcrumb */}
        <div className="breadcrumb">
          <Link to={`/students/${report.student_id}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ArrowLeft size={15} /> Назад к ученику
          </Link>
          <span className="breadcrumb-sep">/</span>
          <span style={{ color: 'var(--c-text)' }}>Отчёт о проверке</span>
        </div>

        {/* HERO */}
        <div className="card" style={{ overflow: 'hidden', marginBottom: 18 }}>
          <div style={{ padding: '26px 28px', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Score ring */}
            <Donut size={132} thickness={14}
              data={[{ value: pct, color: barColor }, { value: 100 - pct, color: '#eef0f3' }]}
              centerLabel={pct + '%'}
              centerSub={`${report.total_score ?? 0} из ${report.max_score ?? 0} б.`} />

            {/* Title + meta */}
            <div style={{ flex: 1, minWidth: 300 }}>
              <h1 style={{ fontSize: 24, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.22 }}>
                {report.title || 'Без названия'}
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="avatar" style={{ width: 28, height: 28, fontSize: 11, flexShrink: 0 }}>{initials}</div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{report.student_name}</span>
                  {report.grade && <span className="badge badge-gray">{report.grade} кл.</span>}
                </span>
                {report.generated_at && (
                  <span style={{ fontSize: 13, color: 'var(--c-text-3)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Clock size={14} />{new Date(report.generated_at).toLocaleDateString('ru-RU')}
                  </span>
                )}
                {report.topic && <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>{report.topic}</span>}
              </div>
            </div>

            {/* Verdict + grade */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 16, flexShrink: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, padding: '14px 18px', background: verdict.bg, border: `1px solid ${verdict.border}`, borderRadius: 14, maxWidth: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {verdict.icon}
                  <span style={{ fontSize: 16, fontWeight: 750, color: verdict.color }}>{verdict.title}</span>
                </div>
                <span style={{ fontSize: 13, color: 'var(--c-text-2)', lineHeight: 1.4 }}>{verdict.sub}</span>
              </div>
              {report.report_grade && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <GradePill grade={Number(report.report_grade)} />
                  <span style={{ fontSize: 12, color: 'var(--c-text-3)', fontWeight: 600 }}>оценка</span>
                </div>
              )}
            </div>
          </div>

          {/* Task map / heatmap */}
          <div style={{ padding: '20px 28px', borderTop: '1px solid var(--c-border-solid)', background: 'var(--c-surface-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Карта работы · {answers.length} заданий
              </span>
              {attentionCount > 0 && (
                <button className="btn btn-sm" style={{ background: '#fff', border: '1px solid var(--c-border-solid)', color: 'var(--c-danger)', fontWeight: 650 }}
                  onClick={() => { const first = answers.find((a: any) => ATTENTION.includes(a.status)); if (first) jumpTo(first) }}>
                  <AlertTriangle size={14} /> К проблемным ({attentionCount})
                </button>
              )}
            </div>

            {/* Proportion bar */}
            <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', gap: 2, marginBottom: 14 }}>
              {(['correct', 'partial', 'manual_required', 'incorrect'] as const).map(st => {
                const n = counts[st] || 0; if (!n) return null
                const m = getR(st)
                return <div key={st} title={`${m.label}: ${n}`} style={{ flex: n, background: m.hollow ? '#fdba74' : m.cell, minWidth: 6 }} />
              })}
            </div>

            {/* Heatmap grouped by slide */}
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {(() => {
                let heatIdx = 0
                return slides.map(s => {
                  const si = heatIdx
                  heatIdx += s.items.length
                  return (
                    <div key={s.slideNum ?? 'none'} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {s.slideNum !== null && (
                        <span style={{ fontSize: 11, color: 'var(--c-text-3)', fontWeight: 700, letterSpacing: '0.03em' }}>СЛАЙД {s.slideNum}</span>
                      )}
                      <div style={{ display: 'flex', gap: 7 }}>
                        {s.items.map((ans: any, ii: number) => {
                          const m = getR(ans.status)
                          const idx = si + ii
                          return (
                            <div key={ans.id} className="heat-cell" onClick={() => jumpTo(ans)}
                              title={`№${idx + 1} · ${m.label}`}
                              style={{ background: m.cell, color: m.cellText, borderColor: m.hollow ? '#fb923c' : 'transparent' }}>
                              {idx + 1}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })
              })()}
              {/* Legend */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginLeft: 'auto', alignSelf: 'center' }}>
                {([['correct', correctCount], ['partial', counts.partial || 0], ['incorrect', counts.incorrect || 0], ['manual_required', counts.manual_required || 0]] as [string, number][]).filter(([, n]) => n > 0).map(([st, n]) => {
                  const m = getR(st)
                  return (
                    <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 4, background: m.hollow ? '#fff' : m.cell, border: m.hollow ? '1.5px solid #fb923c' : 'none', flexShrink: 0 }} />
                      <span style={{ color: 'var(--c-text-2)' }}>{m.label}</span>
                      <span style={{ fontWeight: 700, marginLeft: 2 }}>{n}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* AI summaries */}
        {(report.ai_summary_for_student || report.ai_summary_for_teacher) && (
          <div style={{ display: 'grid', gridTemplateColumns: report.ai_summary_for_student && report.ai_summary_for_teacher ? '1fr 1fr' : '1fr', gap: 14, marginBottom: 14 }}>
            {report.ai_summary_for_student && (
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '15px 17px', background: '#1d4ed80d', borderRadius: 14, border: '1px solid #1d4ed822' }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: '#1d4ed81a', color: 'var(--c-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><MessageSquare size={17} /></span>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--c-primary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Обратная связь ученику</div>
                  <p style={{ fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}>{report.ai_summary_for_student}</p>
                </div>
              </div>
            )}
            {report.ai_summary_for_teacher && (
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '15px 17px', background: '#0d94880d', borderRadius: 14, border: '1px solid #0d948822' }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: '#0d94881a', color: 'var(--c-teal)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><BookOpen size={17} /></span>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--c-teal)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Рекомендации учителю</div>
                  <p style={{ fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}>{report.ai_summary_for_teacher}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Sticky controls */}
        <div style={{
          position: 'sticky', top: 80, zIndex: 60, marginBottom: 18,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '12px 14px', background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(10px)',
          border: '1px solid var(--c-border-solid)', borderRadius: 14, boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="Все" n={answers.length} />
            <FilterChip active={filter === 'attention'} onClick={() => setFilter('attention')} label="Требуют внимания" n={attentionCount} tone="danger" icon={<AlertTriangle size={14} />} />
            <FilterChip active={filter === 'correct'} onClick={() => setFilter('correct')} label="Верно" n={correctCount} tone="success" icon={<CheckCircle size={14} />} />
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={toggleAll}>
            {allExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {allExpanded ? 'Свернуть все' : 'Развернуть все'}
          </button>
        </div>

        {/* Task list */}
        {answers.length === 0 ? (
          <div className="card empty-state">
            <div className="empty-state-icon"><CheckCircle size={36} /></div>
            <p style={{ fontWeight: 600, margin: 0 }}>Нет заданий в этой работе</p>
          </div>
        ) : visibleSlides.length === 0 ? (
          <div className="card empty-state">
            <p style={{ fontWeight: 600, margin: 0 }}>Нет заданий в этой категории</p>
          </div>
        ) : (
          (() => {
            let gi = 0
            return visibleSlides.map(({ slideNum, items }) => (
              <div key={slideNum ?? 'none'} style={{ marginBottom: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: 'var(--c-surface)', border: '1px solid var(--c-border-solid)', borderRadius: 10, padding: '6px 15px', boxShadow: 'var(--shadow-xs)' }}>
                    {slideNum !== null ? (
                      <>
                        <span style={{ fontSize: 11, color: 'var(--c-text-3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Слайд</span>
                        <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--c-primary)', lineHeight: 1 }}>{slideNum}</span>
                        <span style={{ fontSize: 12.5, color: 'var(--c-text-3)', paddingLeft: 8, borderLeft: '1px solid var(--c-border-solid)' }}>{items.length} {plural(items.length, 'задание', 'задания', 'заданий')}</span>
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--c-text-3)', fontStyle: 'italic' }}>Без слайда · {items.length} {plural(items.length, 'задание', 'задания', 'заданий')}</span>
                    )}
                  </div>
                  <div style={{ flex: 1, height: 1, background: 'var(--c-border-solid)' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {items.map((ans: any) => {
                    const idx = gi++
                    return (
                      <div key={ans.id} ref={el => { refs.current[ans.id] = el }}>
                        <TaskCard ans={ans} globalIdx={idx} expanded={expanded.has(ans.id)} onToggle={() => toggle(ans.id)}
                          flash={flashId === ans.id} overrides={overrides} setScore={setScore} qc={qc} sessionId={sessionId!} />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()
        )}

        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
