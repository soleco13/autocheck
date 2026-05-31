import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, CheckCircle, XCircle, AlertCircle, Search,
  Clock, Pencil, BookOpen, MessageSquare, CheckCircle2,
} from 'lucide-react'
import { getCheckReport, overrideAnswerScore } from '../api/client'
import { GradeBadge, StatusBadge } from '../components/StatusBadge'
import { toast } from '../components/Toast'
import { MathText } from '../components/MathText'

const TYPE_LABEL: Record<string, string> = {
  check_value: 'Число', open_answer: 'Открытый', matches: 'Соответствие',
  input: 'Ввод', quiz: 'Тест', fill_blanks: 'Пропуски',
}

const ACCENT: Record<string, string> = {
  correct: '#22c55e', partial: '#f59e0b', incorrect: '#ef4444',
  manual_required: '#f59e0b', pending: '#94a3b8', error: '#ef4444',
}

const SCORE_COLOR: Record<string, string> = {
  correct: '#16a34a', partial: '#b45309', incorrect: '#dc2626',
  manual_required: '#b45309', pending: '#94a3b8', error: '#dc2626',
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  correct:         <CheckCircle size={14} color="#22c55e" />,
  partial:         <AlertCircle size={14} color="#f59e0b" />,
  incorrect:       <XCircle size={14} color="#ef4444" />,
  manual_required: <Search size={14} color="#f59e0b" />,
  pending:         <Clock size={14} color="#94a3b8" />,
  error:           <XCircle size={14} color="#ef4444" />,
}

const STATUS_LABEL: Record<string, string> = {
  correct: 'Верно', partial: 'Частично верно', incorrect: 'Неверно',
  manual_required: 'Проверьте вручную', pending: 'Ожидание', error: 'Ошибка',
}

function Pill({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 99, fontSize: 12.5, fontWeight: 500,
      background: bg, color,
    }}>
      {children}
    </span>
  )
}

function ReportSkeleton() {
  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="skeleton" style={{ height: 14, width: 160, marginBottom: 20 }} />
      <div className="card p-6 mb-4">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 26, width: '55%', marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 14, width: '30%', marginBottom: 22 }} />
            <div className="skeleton" style={{ height: 8, borderRadius: 99, marginBottom: 10 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              {[68, 85, 90].map((w, i) => <div key={i} className="skeleton" style={{ height: 22, width: w, borderRadius: 99 }} />)}
            </div>
          </div>
          <div className="skeleton" style={{ width: 56, height: 56, borderRadius: 14, marginLeft: 24 }} />
        </div>
      </div>
      {/* Slide group skeleton */}
      <div className="skeleton" style={{ height: 34, width: 140, borderRadius: 8, marginBottom: 8 }} />
      {[1,2,3,4,5].map(i => (
        <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10, marginBottom: 4 }} />
      ))}
    </div>
  )
}

export default function Report() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const qc = useQueryClient()
  const [overriding, setOverriding] = useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = useState<string | null>(null)

  const { data: report, isLoading } = useQuery({
    queryKey: ['report', sessionId],
    queryFn: () => getCheckReport(sessionId!),
  })

  const handleOverride = async (answerId: string, score: number) => {
    setOverriding(answerId)
    try {
      await overrideAnswerScore(answerId, score)
      qc.invalidateQueries({ queryKey: ['report', sessionId] })
      toast.success('Балл обновлён')
      setOverrideOpen(null)
    } catch {
      toast.error('Не удалось обновить балл')
    } finally {
      setOverriding(null)
    }
  }

  // ── Render a single answer card ─────────────────────────────────────────
  function renderAnswer(ans: any, globalIdx: number) {
    const accent = ACCENT[ans.status] ?? '#94a3b8'
    const scoreColor = SCORE_COLOR[ans.status] ?? '#94a3b8'
    const effectiveScore = ans.teacher_override_score ?? ans.score ?? 0
    const maxScore = ans.task_max_score || 1
    const structured = ans.student_answer_structured
    const isOverrideOpenNow = overrideOpen === ans.id

    return (
      <div
        key={ans.id}
        style={{
          background: 'var(--c-surface)',
          borderRadius: 10,
          border: '1px solid var(--c-border-solid)',
          borderLeft: `4px solid ${accent}`,
          overflow: 'hidden',
        }}
      >
        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 0' }}>
          <span style={{ flexShrink: 0 }}>{STATUS_ICON[ans.status]}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: scoreColor, flexShrink: 0 }}>
            {STATUS_LABEL[ans.status] || ans.status}
          </span>
          <span style={{ color: 'var(--c-border-solid)', fontSize: 16 }}>·</span>
          <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>#{globalIdx + 1}</span>
          {ans.task_type && (
            <span style={{
              fontSize: 11, fontWeight: 600, color: 'var(--c-text-3)',
              background: 'var(--c-surface-2)', padding: '1px 7px', borderRadius: 99,
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
              {TYPE_LABEL[ans.task_type] || ans.task_type}
            </span>
          )}
          {ans.teacher_override_at && (
            <span style={{ fontSize: 11, color: '#b45309', display: 'flex', alignItems: 'center', gap: 3 }}>
              <Pencil size={10} /> скорр.
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 2 }}>
            <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1, color: scoreColor }}>{effectiveScore}</span>
            <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>/{maxScore}</span>
          </div>
        </div>

        {/* Question text */}
        {ans.question_text && (
          <div style={{ margin: '6px 16px 0', fontSize: 14, fontWeight: 500, color: 'var(--c-text)', lineHeight: 1.6 }}>
            <MathText>{ans.question_text}</MathText>
          </div>
        )}

        {/* Answer content */}
        <div style={{ padding: '10px 16px 14px' }}>

          {/* QUIZ */}
          {ans.task_type === 'quiz' && structured?.allOptions && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {structured.allOptions.map((opt: any, i: number) => {
                let bg = '#f1f5f9', color = '#64748b', border = '1px solid #e2e8f0', weight = 400
                if (opt.isChecked && opt.isCorrect)  { bg = '#dcfce7'; color = '#166534'; border = '1.5px solid #22c55e'; weight = 600 }
                if (opt.isChecked && !opt.isCorrect) { bg = '#fee2e2'; color = '#991b1b'; border = '1.5px solid #ef4444'; weight = 600 }
                if (!opt.isChecked && opt.isCorrect) { bg = '#fef9c3'; color = '#92400e'; border = '1.5px dashed #f59e0b'; weight = 500 }
                return (
                  <span key={i} style={{ padding: '4px 12px', borderRadius: 99, fontSize: 13, fontWeight: weight, background: bg, color, border, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {opt.isChecked && opt.isCorrect  && <CheckCircle2 size={12} />}
                    {opt.isChecked && !opt.isCorrect && <XCircle size={12} />}
                    {!opt.isChecked && opt.isCorrect && <AlertCircle size={12} />}
                    <MathText>{opt.text}</MathText>
                  </span>
                )
              })}
            </div>
          )}

          {/* FILL_BLANKS */}
          {ans.task_type === 'fill_blanks' && structured?.items && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              {structured.items.map((item: any, i: number) => {
                const ok = item.studentAnswer === item.correctAnswer
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ color: ok ? '#22c55e' : '#ef4444', flexShrink: 0 }}>
                      {ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                    </span>
                    <span style={{ color: 'var(--c-text-2)', minWidth: 160, flexShrink: 0 }}><MathText>{item.questionText}</MathText></span>
                    <span style={{ fontWeight: 600, color: ok ? '#166534' : '#991b1b' }}><MathText>{item.studentAnswer || '(пусто)'}</MathText></span>
                    {!ok && item.correctAnswer && (
                      <span style={{ color: 'var(--c-text-3)', fontSize: 12 }}>
                        → <span style={{ color: '#16a34a', fontWeight: 500 }}>{item.correctAnswer}</span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* MATCHES */}
          {ans.task_type === 'matches' && ans.student_answer && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {ans.student_answer.split('\n').filter(Boolean).map((pair: string, i: number) => {
                const [left, right] = pair.split(' → ')
                return (
                  <span key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'var(--c-primary-light)', border: '1px solid var(--c-primary-muted)',
                    borderRadius: 8, padding: '4px 10px', fontSize: 13,
                  }}>
                    <span style={{ fontWeight: 600 }}><MathText>{left}</MathText></span>
                    <span style={{ color: 'var(--c-primary)', fontWeight: 700 }}>→</span>
                    <span><MathText>{right || ''}</MathText></span>
                  </span>
                )
              })}
            </div>
          )}

          {/* GENERIC (check_value, open_answer, input) */}
          {!['quiz', 'fill_blanks', 'matches'].includes(ans.task_type) && (
            <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
              {ans.student_answer && (
                <div style={{ flex: 1, minWidth: 180 }}>
                  <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 600, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Ответ ученика
                  </p>
                  <div style={{ fontSize: 14, color: 'var(--c-text)', fontWeight: 500, lineHeight: 1.6 }}>
                    <MathText>{ans.student_answer}</MathText>
                  </div>
                </div>
              )}
              {ans.task_reference_answer && (
                <div style={{ flex: 1, minWidth: 180, paddingLeft: 12, borderLeft: '2px solid #22c55e' }}>
                  <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 600, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Правильный ответ
                  </p>
                  <div style={{ fontSize: 14, color: '#166534', fontWeight: 500 }}>
                    <MathText>{ans.task_reference_answer}</MathText>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AI feedback */}
          {ans.ai_feedback && ans.task_type !== 'fill_blanks' && (
            <div style={{
              margin: '8px 0 0', fontSize: 13, color: 'var(--c-text-2)', lineHeight: 1.55,
              fontStyle: 'italic', paddingTop: 8, borderTop: '1px solid var(--c-border-solid)',
            }}>
              <MathText>{ans.ai_feedback}</MathText>
            </div>
          )}

          {/* Teacher note */}
          {ans.ai_teacher_note && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <BookOpen size={12} color="#d97706" style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ margin: 0, fontSize: 12, color: '#b45309', lineHeight: 1.55, fontStyle: 'italic' }}>
                {ans.ai_teacher_note}
              </p>
            </div>
          )}

          {/* Score override */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => setOverrideOpen(isOverrideOpenNow ? null : ans.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
                color: 'var(--c-text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              <Pencil size={11} /> изменить балл
            </button>
            {isOverrideOpenNow && (
              <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
                {Array.from({ length: maxScore + 1 }, (_, i) => i).map(score => (
                  <button
                    key={score}
                    onClick={() => handleOverride(ans.id, score)}
                    disabled={overriding === ans.id}
                    style={{
                      width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer',
                      fontWeight: 700, fontSize: 12, transition: 'background 0.15s',
                      background: effectiveScore === score ? 'var(--c-primary)' : 'var(--c-surface-2)',
                      color: effectiveScore === score ? '#fff' : 'var(--c-text)',
                      opacity: overriding === ans.id ? 0.5 : 1,
                      outline: effectiveScore === score ? '2px solid var(--c-primary-muted)' : 'none',
                    }}
                  >
                    {score}
                  </button>
                ))}
                {overriding === ans.id && (
                  <span className="spinner spinner-dark" style={{ width: 13, height: 13, borderWidth: 2, alignSelf: 'center', marginLeft: 4 }} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Loading & error states ──────────────────────────────────────────────
  if (isLoading) return <ReportSkeleton />

  if (!report) {
    return (
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div className="card empty-state">
          <div className="empty-state-icon"><Search size={36} /></div>
          <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Отчёт не найден</p>
        </div>
      </div>
    )
  }

  const answers: any[] = report.answers ?? []
  const correctCount   = answers.filter(a => a.status === 'correct').length
  const incorrectCount = answers.filter(a => a.status === 'incorrect').length
  const partialCount   = answers.filter(a => a.status === 'partial').length
  const manualCount    = answers.filter(a => a.status === 'manual_required').length
  const pct = report.percentage ? Math.round(Number(report.percentage)) : 0
  const barColor = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444'

  // ── Group by slide ──────────────────────────────────────────────────────
  type SlideGroup = { slideNum: number | null; items: any[] }
  const slides: SlideGroup[] = []
  const slideMap = new Map<number | string, number>()
  answers.forEach(ans => {
    const sn: number | null = ans.student_answer_structured?._slideNum ?? ans.slide_num ?? null
    const key = sn ?? '__none__'
    if (!slideMap.has(key)) {
      slideMap.set(key, slides.length)
      slides.push({ slideNum: sn, items: [] })
    }
    slides[slideMap.get(key)!].items.push(ans)
  })
  slides.sort((a, b) => {
    if (a.slideNum === null && b.slideNum === null) return 0
    if (a.slideNum === null) return 1
    if (b.slideNum === null) return -1
    return a.slideNum - b.slideNum
  })

  let globalAnswerIdx = 0

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>

      {/* Breadcrumb */}
      <div className="breadcrumb" style={{ marginBottom: 18 }}>
        <Link to={`/students/${report.student_id}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <ArrowLeft size={14} /> Назад к ученику
        </Link>
      </div>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div className="card p-6 mb-4" style={{ borderRadius: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 800, lineHeight: 1.3, color: 'var(--c-text)' }}>
              {report.title || 'Без названия'}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
              <span style={{ fontSize: 14, color: 'var(--c-text-2)', fontWeight: 500 }}>{report.student_name}</span>
              {report.grade && <span className="badge badge-gray">{report.grade} кл.</span>}
              {report.topic && <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>{report.topic}</span>}
              <StatusBadge status={report.status || 'completed'} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: 'var(--c-text-2)' }}>{report.total_score} / {report.max_score} баллов</span>
                <span style={{ fontWeight: 700, color: barColor }}>{pct}%</span>
              </div>
              <div style={{ height: 8, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 99, transition: 'width 0.6s ease' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {correctCount > 0   && <Pill color="#166534" bg="#dcfce7"><CheckCircle size={11}/>{correctCount} верно</Pill>}
              {partialCount > 0   && <Pill color="#92400e" bg="#fef9c3"><AlertCircle size={11}/>{partialCount} частично</Pill>}
              {incorrectCount > 0 && <Pill color="#991b1b" bg="#fee2e2"><XCircle size={11}/>{incorrectCount} неверно</Pill>}
              {manualCount > 0    && <Pill color="#92400e" bg="#fef9c3"><Search size={11}/>{manualCount} вручную</Pill>}
            </div>
          </div>
          {report.report_grade && (
            <div style={{ flexShrink: 0 }}>
              <GradeBadge grade={report.report_grade} size="lg" />
            </div>
          )}
        </div>

        {/* AI summaries */}
        {(report.ai_summary_for_student || report.ai_summary_for_teacher) && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: report.ai_summary_for_student && report.ai_summary_for_teacher ? '1fr 1fr' : '1fr',
            gap: 10, marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--c-border-solid)',
          }}>
            {report.ai_summary_for_student && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <MessageSquare size={15} color="#3b82f6" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ученику</p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)', lineHeight: 1.6 }}>{report.ai_summary_for_student}</p>
                </div>
              </div>
            )}
            {report.ai_summary_for_teacher && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <BookOpen size={15} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Учителю</p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)', lineHeight: 1.6 }}>{report.ai_summary_for_teacher}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── TASKS grouped by slide ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Задания · {answers.length}
        </p>
        {slides.length > 1 && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--c-text-3)' }}>
            {slides.filter(s => s.slideNum !== null).length} слайдов
          </p>
        )}
      </div>

      {answers.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon"><CheckCircle size={36} /></div>
          <p style={{ fontWeight: 600, margin: 0 }}>Нет заданий в этой работе</p>
        </div>
      ) : (
        slides.map(({ slideNum, items }) => (
          <div key={slideNum ?? 'none'} style={{ marginBottom: 24 }}>

            {/* Slide header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              {slideNum !== null ? (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  background: 'var(--c-surface)', border: '1px solid var(--c-border-solid)',
                  borderRadius: 8, padding: '5px 14px',
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--c-text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Слайд
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--c-primary)', lineHeight: 1 }}>
                    {slideNum}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--c-text-3)', paddingLeft: 4, borderLeft: '1px solid var(--c-border-solid)' }}>
                    {items.length} {items.length === 1 ? 'задание' : items.length < 5 ? 'задания' : 'заданий'}
                  </span>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--c-text-3)', fontWeight: 600, fontStyle: 'italic' }}>
                  Без номера слайда
                </span>
              )}
              <div style={{ flex: 1, height: 1, background: 'var(--c-border-solid)' }} />
            </div>

            {/* Answers in this slide */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {items.map(ans => renderAnswer(ans, globalAnswerIdx++))}
            </div>
          </div>
        ))
      )}

      <div style={{ height: 32 }} />
    </div>
  )
}
