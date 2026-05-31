import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Settings as SettingsIcon, Zap, MessageSquare, RefreshCw,
  CheckCircle, ChevronDown, ChevronUp, RotateCcw,
} from 'lucide-react'
import { getAiUsage, getAiPrompts, saveAiPrompt } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { toast } from '../components/Toast'

const PROMPT_META: Record<string, { label: string; hint: string; icon: React.ReactNode }> = {
  checker_system: {
    label: 'Системный промпт проверки',
    hint: 'Инструкции ИИ-проверщику при оценке каждого ответа ученика. Используется моделью claude-haiku.',
    icon: <Zap size={15} color="var(--c-primary)" />,
  },
  report_student: {
    label: 'Комментарий ученику',
    hint: 'Промпт для генерации итогового комментария, который показывается ученику.',
    icon: <MessageSquare size={15} color="var(--c-teal)" />,
  },
  report_teacher: {
    label: 'Сводка для учителя',
    hint: 'Промпт для генерации сводки, которую видит только учитель.',
    icon: <MessageSquare size={15} color="var(--c-warn)" />,
  },
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function UsageBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 13 }}>
        <span style={{ color: 'var(--c-text-2)' }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{formatNum(value)}</span>
      </div>
      <div className="progress-bar" style={{ height: 6 }}>
        <div
          className="progress-bar-fill"
          style={{ width: `${pct}%`, background: color, transition: 'width 0.6s ease' }}
        />
      </div>
    </div>
  )
}

function PromptEditor({
  promptKey,
  defaultText,
  savedText,
  meta,
}: {
  promptKey: string
  defaultText: string
  savedText: string
  meta: typeof PROMPT_META[string]
}) {
  const [value, setValue] = useState(savedText)
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const isDirty = value !== savedText
  const isCustom = savedText !== defaultText

  const mutation = useMutation({
    mutationFn: (text: string) => saveAiPrompt(promptKey, text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-prompts'] })
      toast.success('Промпт сохранён')
    },
    onError: () => toast.error('Ошибка сохранения'),
  })

  const handleReset = () => {
    setValue(defaultText)
    mutation.mutate('')
  }

  useEffect(() => {
    setValue(savedText)
  }, [savedText])

  return (
    <div className="card" style={{ overflow: 'hidden', border: isCustom ? '1px solid var(--c-primary-muted)' : '1px solid var(--c-border-solid)' }}>
      {/* Header */}
      <div
        style={{
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          cursor: 'pointer', background: isCustom ? 'var(--c-primary-light)' : 'var(--c-surface)',
          userSelect: 'none',
        }}
        onClick={() => setOpen(v => !v)}
      >
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'rgba(255,255,255,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--c-border-solid)', flexShrink: 0,
        }}>
          {meta.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{meta.label}</span>
            {isCustom && <span className="badge badge-blue" style={{ fontSize: 11 }}>изменён</span>}
          </div>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>{meta.hint}</p>
        </div>
        {open ? <ChevronUp size={15} color="var(--c-text-3)" /> : <ChevronDown size={15} color="var(--c-text-3)" />}
      </div>

      {/* Editor */}
      {open && (
        <div style={{ padding: '14px 16px', borderTop: '1px solid var(--c-border-solid)' }}>
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            className="input"
            style={{
              width: '100%', minHeight: 120, resize: 'vertical',
              fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.6,
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            {isCustom && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleReset}
                disabled={mutation.isPending}
                title="Сбросить до стандартного промпта"
              >
                <RotateCcw size={13} />
                Сбросить
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => mutation.mutate(value)}
              disabled={!isDirty || mutation.isPending}
            >
              {mutation.isPending
                ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />Сохранение...</>
                : <><CheckCircle size={13} />Сохранить</>
              }
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Settings() {
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

  const prompts: Record<string, string> = promptsData?.prompts ?? {}
  const defaults: Record<string, string> = promptsData?.defaults ?? {}

  const monthIn = usage?.month?.inputTokens ?? 0
  const monthOut = usage?.month?.outputTokens ?? 0
  const monthTotal = monthIn + monthOut
  const monthCalls = usage?.month?.totalCalls ?? 0

  const totalIn = usage?.total?.inputTokens ?? 0
  const totalOut = usage?.total?.outputTokens ?? 0
  const totalCalls = usage?.total?.totalCalls ?? 0

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Настройки</h1>
          <p className="page-subtitle">Конфигурация AutoCheck</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>

        {/* ── AI USAGE ─────────────────────────────────────────── */}
        <div>
          <div className="card p-6 mb-5">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: 'var(--c-primary-light)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Zap size={18} color="var(--c-primary)" />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Использование API</h2>
                  <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>Токены Claude AI</p>
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => refetchUsage()}
                title="Обновить"
              >
                <RefreshCw size={13} />
              </button>
            </div>

            {usageLoading ? (
              <>
                <Skeleton height={40} style={{ marginBottom: 12 }} />
                <Skeleton height={40} style={{ marginBottom: 12 }} />
                <Skeleton height={40} />
              </>
            ) : (
              <>
                {/* This month */}
                <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Этот месяц
                </p>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                  gap: 10, marginBottom: 16,
                }}>
                  {[
                    { label: 'Запросов', value: monthCalls },
                    { label: 'Вход. токены', value: formatNum(monthIn) },
                    { label: 'Исход. токены', value: formatNum(monthOut) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{
                      background: 'var(--c-surface-2)', borderRadius: 8,
                      padding: '10px 12px', textAlign: 'center',
                      border: '1px solid var(--c-border-solid)',
                    }}>
                      <p style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>{value}</p>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--c-text-3)' }}>{label}</p>
                    </div>
                  ))}
                </div>

                {/* Progress bars */}
                <UsageBar
                  label="Входящие токены (этот месяц)"
                  value={monthIn}
                  max={Math.max(monthIn, totalIn / 3)}
                  color="var(--c-primary)"
                />
                <UsageBar
                  label="Исходящие токены (этот месяц)"
                  value={monthOut}
                  max={Math.max(monthOut, totalOut / 3)}
                  color="var(--c-teal)"
                />

                <div style={{ height: 1, background: 'var(--c-border-solid)', margin: '16px 0' }} />

                {/* All time */}
                <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--c-text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Всего
                </p>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Запросов', value: totalCalls },
                    { label: 'Входящих токенов', value: formatNum(totalIn) },
                    { label: 'Исходящих токенов', value: formatNum(totalOut) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ fontSize: 13 }}>
                      <span style={{ color: 'var(--c-text-3)' }}>{label}: </span>
                      <span style={{ fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* System info */}
          <div className="card p-6">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'var(--c-teal-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <SettingsIcon size={18} color="var(--c-teal)" />
              </div>
              <div>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Система</h2>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>Конфигурация AutoCheck</p>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Модель проверки', value: 'claude-haiku-4-5' },
                { label: 'Модель отчётов', value: 'claude-sonnet-4-6' },
                { label: 'Платформа', value: 'good-teach.itgen.io' },
                { label: 'База данных', value: 'PostgreSQL 16' },
              ].map(({ label, value }) => (
                <div key={label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', background: 'var(--c-surface-2)', borderRadius: 8,
                }}>
                  <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{label}</span>
                  <code style={{ fontSize: 12, background: '#e2e8f0', padding: '2px 8px', borderRadius: 6 }}>{value}</code>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── AI PROMPTS ───────────────────────────────────────── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <MessageSquare size={16} color="var(--c-text-2)" />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Промпты ИИ</h2>
            <span className="badge badge-gray" style={{ fontSize: 11 }}>настраиваемые</span>
          </div>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--c-text-2)', lineHeight: 1.6 }}>
            Настройте инструкции для ИИ. Изменения применяются к следующим проверкам.
            Пустой промпт сбрасывает к стандартному.
          </p>

          {promptsLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[1, 2, 3].map(i => (
                <div key={i} className="card" style={{ height: 66 }}>
                  <div style={{ padding: '14px 16px', display: 'flex', gap: 12 }}>
                    <Skeleton width={32} height={32} />
                    <div style={{ flex: 1 }}>
                      <Skeleton height={14} width="50%" style={{ marginBottom: 6 }} />
                      <Skeleton height={11} width="80%" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Object.keys(PROMPT_META).map(key => (
                <PromptEditor
                  key={key}
                  promptKey={key}
                  defaultText={defaults[key] ?? ''}
                  savedText={prompts[key] ?? ''}
                  meta={PROMPT_META[key]}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
