import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Zap, MessageSquare, CheckCircle, RotateCcw, AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { getAiUsage, getAiPrompts, saveAiPrompt, getMe } from '../api/client'
import { toast } from '../components/Toast'

const PROMPT_META: Record<string, { label: string; desc: string }> = {
  checker_system: {
    label: 'Системный промпт проверки',
    desc: 'Основные инструкции для ИИ при проверке работ (модель claude-haiku)',
  },
  report_student: {
    label: 'Промпт комментария ученику',
    desc: 'Как ИИ формулирует обратную связь для ученика',
  },
  report_teacher: {
    label: 'Промпт рекомендаций учителю',
    desc: 'Сводка и рекомендации для преподавателя',
  },
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function SkelLine({ w = '100%', h = 14 }: { w?: string | number; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: 8 }} />
}

function ConfirmModal({ open, title, sub, onConfirm, onCancel }: { open: boolean; title: string; sub: string; onConfirm: () => void; onCancel: () => void }) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: 28 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--c-warn-light)', color: 'var(--c-warn)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <AlertTriangle size={22} />
            </span>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>{title}</h3>
              <p style={{ fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}>{sub}</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onCancel}>Отмена</button>
            <button className="btn btn-primary" onClick={onConfirm}>Да, сохранить</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PromptCard({ promptKey, defaultText, savedText }: { promptKey: string; defaultText: string; savedText: string }) {
  const [value, setValue] = useState(savedText)
  const [open, setOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const qc = useQueryClient()
  const meta = PROMPT_META[promptKey] || { label: promptKey, desc: '' }
  const isCustom = savedText !== defaultText
  const isDirty = value !== savedText

  const mutation = useMutation({
    mutationFn: (text: string) => saveAiPrompt(promptKey, text),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai-prompts'] }); toast.success('Промпт сохранён') },
    onError: () => toast.error('Ошибка сохранения'),
  })

  useEffect(() => { setValue(savedText) }, [savedText])

  const askSave = () => setConfirmOpen(true)
  const doSave = () => { mutation.mutate(value); setConfirmOpen(false) }
  const doReset = () => { setValue(defaultText); mutation.mutate('') }

  return (
    <>
      <div className="card" style={{ overflow: 'hidden', border: isCustom ? '1px solid var(--c-primary-muted)' : '1px solid var(--c-border-solid)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '18px 20px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{meta.label}</h3>
              {isCustom && <span className="badge badge-blue" style={{ fontSize: 11 }}>изменён</span>}
            </div>
            <p style={{ fontSize: 13.5, color: 'var(--c-text-3)', margin: 0 }}>{meta.desc}</p>
          </div>
          {!open && <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}><RotateCcw size={13} /> Редактировать</button>}
        </div>

        {!open && (
          <div style={{ padding: '0 20px 18px' }}>
            <div
              style={{ fontSize: 13.5, color: 'var(--c-text-2)', lineHeight: 1.65, background: 'var(--c-surface-2)', padding: '12px 14px', borderRadius: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace', cursor: 'pointer' }}
              onClick={() => setOpen(true)}>
              {savedText || defaultText || '(стандартный промпт)'}
            </div>
          </div>
        )}

        {open && (
          <div style={{ padding: '0 20px 18px', borderTop: '1px solid var(--c-border-solid)' }}>
            <div style={{ paddingTop: 16 }}>
              <textarea className="input" value={value} onChange={e => setValue(e.target.value)} rows={6}
                style={{ resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary btn-sm" onClick={askSave} disabled={!isDirty || mutation.isPending}>
                  <CheckCircle size={14} /> Сохранить
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setValue(savedText) }}>Отмена</button>
                {isCustom && (
                  <button className="btn btn-ghost btn-sm" onClick={doReset} style={{ marginLeft: 'auto', color: 'var(--c-text-3)' }}>
                    <RotateCcw size={13} /> Сбросить
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Подтвердите изменение промпта"
        sub="Новый промпт будет применяться ко всем последующим проверкам. Вы уверены?"
        onConfirm={doSave}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

export default function Settings() {
  const [tab, setTab] = useState<'general' | 'prompts'>('general')

  const { data: usage, isLoading: usageLoading, refetch: refetchUsage } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: getAiUsage,
    staleTime: 60_000,
  })
  const { data: promptsData, isLoading: promptsLoading } = useQuery({
    queryKey: ['ai-prompts'],
    queryFn: getAiPrompts,
    staleTime: 60_000,
  })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })

  const prompts: Record<string, string> = promptsData?.prompts ?? {}
  const defaults: Record<string, string> = promptsData?.defaults ?? {}

  const totalIn = usage?.total?.inputTokens ?? 0
  const totalOut = usage?.total?.outputTokens ?? 0
  const totalCalls = usage?.total?.totalCalls ?? 0
  const monthIn = usage?.month?.inputTokens ?? 0
  const monthOut = usage?.month?.outputTokens ?? 0
  const monthCalls = usage?.month?.totalCalls ?? 0
  const creditUsed = totalIn + totalOut
  const creditMax = 10_000_000
  const creditPct = Math.round((creditUsed / creditMax) * 100)
  const remaining = creditMax - creditUsed

  const teacherName = (me as any)?.teacher?.full_name || (me as any)?.teacher?.email || 'Учитель'
  const teacherEmail = (me as any)?.teacher?.email || ''
  const teacherSchool = (me as any)?.teacher?.school || 'AutoCheck'
  const initials = teacherName.split(' ').map((w: string) => w[0]).slice(0, 2).join('')

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Настройки</h1>
          <p className="page-subtitle">Управление кредитами и промптами для ИИ</p>
        </div>
      </div>

      <div className="segmented" style={{ marginBottom: 24 }}>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>Использование</button>
        <button className={tab === 'prompts' ? 'active' : ''} onClick={() => setTab('prompts')}>Промпты ИИ</button>
      </div>

      {tab === 'general' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Credits card */}
          <div className="card card-pad">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--c-teal-light)', color: 'var(--c-teal)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap size={22} />
              </span>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Токены ИИ</h3>
                <p style={{ fontSize: 13.5, color: 'var(--c-text-3)', margin: 0 }}>Расход на проверку работ через ИИ</p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => refetchUsage()} title="Обновить">
                <RefreshCw size={14} />
              </button>
            </div>

            {usageLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SkelLine w={200} h={40} />
                <SkelLine h={12} />
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 }}>
                  <div>
                    <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em' }}>{formatNum(creditUsed)}</span>
                    <span style={{ fontSize: 17, color: 'var(--c-text-3)', fontWeight: 600 }}> / {formatNum(creditMax)}</span>
                  </div>
                  <span className="badge badge-teal" style={{ fontSize: 14 }}>{creditPct}% использовано</span>
                </div>
                <div className="progress-bar" style={{ height: 12 }}>
                  <div className="progress-bar-fill teal" style={{ width: `${Math.min(100, creditPct)}%`, transition: 'width 0.6s ease' }} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--c-border-solid)' }}>
                  {[
                    { label: 'Осталось токенов', value: formatNum(remaining) },
                    { label: 'Запросов всего', value: totalCalls },
                    { label: 'Входящих всего', value: formatNum(totalIn) },
                    { label: 'Исходящих всего', value: formatNum(totalOut) },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div style={{ fontSize: 13, color: 'var(--c-text-3)' }}>{label}</div>
                      <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3 }}>{value}</div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--c-border-solid)' }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>Этот месяц</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                    {[
                      { label: 'Запросов', value: monthCalls },
                      { label: 'Входящих', value: formatNum(monthIn) },
                      { label: 'Исходящих', value: formatNum(monthOut) },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ background: 'var(--c-surface-2)', border: '1px solid var(--c-border-solid)', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}>
                        <div style={{ fontSize: 20, fontWeight: 800 }}>{value}</div>
                        <div style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Profile card */}
          <div className="card card-pad">
            <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 18px' }}>Профиль</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div className="avatar" style={{ width: 56, height: 56, fontSize: 22, flexShrink: 0 }}>{initials}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16.5, fontWeight: 700 }}>{teacherName}</div>
                <div style={{ fontSize: 14, color: 'var(--c-text-3)', marginTop: 2 }}>{teacherEmail} · {teacherSchool}</div>
              </div>
            </div>

            <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--c-border-solid)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { label: 'Модель проверки', value: 'claude-haiku-4-5' },
                { label: 'Модель отчётов', value: 'claude-sonnet-4-6' },
                { label: 'Платформа', value: 'good-teach.itgen.io' },
                { label: 'База данных', value: 'PostgreSQL 16' },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--c-surface-2)', borderRadius: 9 }}>
                  <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{label}</span>
                  <code style={{ fontSize: 12, background: 'var(--c-surface-3)', padding: '2px 8px', borderRadius: 6, color: 'var(--c-text)' }}>{value}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'prompts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Warning */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 18px', background: 'var(--c-warn-light)', border: '1px solid #fde68a', borderRadius: 14 }}>
            <AlertTriangle size={19} color="var(--c-warn)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: '#92400e' }}>Изменяйте промпты с осторожностью</div>
              <p style={{ fontSize: 13.5, color: '#b45309', margin: '3px 0 0', lineHeight: 1.5 }}>
                Промпты напрямую влияют на качество и стиль проверки. Некорректные изменения могут привести к ошибочным оценкам. Каждое сохранение требует подтверждения.
              </p>
            </div>
          </div>

          {promptsLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 16 }} />)}
            </div>
          ) : (
            Object.keys(PROMPT_META).map(key => (
              <PromptCard key={key} promptKey={key} defaultText={defaults[key] ?? ''} savedText={prompts[key] ?? ''} />
            ))
          )}
        </div>
      )}
    </div>
  )
}
