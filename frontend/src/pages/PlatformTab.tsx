import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity, Clock, Database, AlertTriangle, RefreshCw,
  Zap, TrendingUp, TrendingDown, Minus,
  CheckCircle, WifiOff, Send,
} from 'lucide-react'
import { getPlatformStatus, getPlatformReport } from '../api/client'
import { LineChart, Sparkline, StackedArea } from '../components/PlatformCharts'
import { toast } from '../components/Toast'

/* ── types ─────────────────────────────────────────────── */
interface RTPoint  { ts: number; wait: number; db: number; http: number; compute: number; async: number }
interface THPoint  { ts: number; rpm: number }
interface ERPoint  { ts: number; count: number }
interface FSPoint  { ts: number; kb: number }
interface Metrics {
  responseTime: { wait: number; db: number; http: number; compute: number; async: number; total: number }
  errorRate: number; throughput: number; fetchedDocKb: number
  timeseries: { responseTime: RTPoint[]; throughput: THPoint[]; errors: ERPoint[]; fetchedDoc: FSPoint[] }
  updatedAt: number; connected: boolean
}

/* ── ranges (30-min resolution from Monti) ──────────────── */
const RANGES = [
  { key: '6ч',  pts: 12, label: 'за 6 часов' },
  { key: '12ч', pts: 24, label: 'за 12 часов' },
  { key: '24ч', pts: 48, label: 'за сутки' },
]

function xLabels(n: number, key: string) {
  const ends: Record<string, string> = { '6ч': '−6ч', '12ч': '−12ч', '24ч': '−24ч' }
  return [
    { i: 0,          label: ends[key] ?? '−24ч' },
    { i: Math.floor(n / 2), label: key === '6ч' ? '−3ч' : key === '12ч' ? '−6ч' : '−12ч' },
    { i: n - 1,      label: 'сейчас' },
  ]
}

/* ── helpers ─────────────────────────────────────────────── */
const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
const last = <T,>(arr: T[]) => arr[arr.length - 1]
const f0 = (v: number) => String(Math.round(v))
const f1 = (v: number) => v.toFixed(1)

/* ── Trend chip ──────────────────────────────────────────── */
function Trend({ data }: { data: number[] }) {
  if (data.length < 4) return null
  const first = avg(data.slice(0, Math.max(1, Math.floor(data.length / 4))))
  const lv    = avg(data.slice(-Math.max(1, Math.floor(data.length / 4))))
  const pct   = first ? Math.round(((lv - first) / first) * 100) : 0
  const dir   = Math.abs(pct) < 1 ? 'flat' : pct > 0 ? 'up' : 'down'
  return (
    <span className={`pf-trend ${dir}`}>
      {dir === 'up'   && <TrendingUp size={13} />}
      {dir === 'down' && <TrendingDown size={13} />}
      {dir === 'flat' && <Minus size={13} />}
      {dir === 'flat' ? '0%' : `${pct > 0 ? '+' : ''}${pct}%`}
    </span>
  )
}

/* ── KPI card ────────────────────────────────────────────── */
function KpiCard({ icon: Icon, color, bg, label, value, unit, spark, trend, delay }: {
  icon: any; color: string; bg: string; label: string
  value: string; unit?: string; spark?: number[]; trend?: number[]; delay?: number
}) {
  return (
    <div className="pf-kpi pf-anim" style={{ animationDelay: `${delay ?? 0}s` }}>
      <div className="pf-kpi-top">
        <span className="pf-kpi-ico" style={{ background: bg, color }}><Icon size={19} /></span>
        <span className="pf-kpi-label">{label}</span>
        {trend && <span style={{ marginLeft: 'auto' }}><Trend data={trend} /></span>}
      </div>
      <div className="pf-kpi-val">{value}{unit && <span className="pf-kpi-unit">{unit}</span>}</div>
      {spark && spark.length > 1 && (
        <div className="pf-kpi-spark"><Sparkline data={spark} color={color} /></div>
      )}
    </div>
  )
}

/* ── Chart card ──────────────────────────────────────────── */
function ChartCard({ icon: Icon, iconColor, title, sub, now, nowUnit, delay, children }: {
  icon?: any; iconColor?: string; title: string; sub?: string
  now?: string; nowUnit?: string; delay?: number; children: React.ReactNode
}) {
  return (
    <div className="pf-card pf-anim" style={{ animationDelay: `${delay ?? 0}s` }}>
      <div className="pf-card-head">
        <div>
          <div className="pf-card-title">
            {Icon && <Icon size={17} color={iconColor ?? 'var(--c-text-2)'} />}
            {title}
          </div>
          {sub && <div className="pf-card-sub">{sub}</div>}
        </div>
        {now != null && (
          <div className="pf-card-now">
            <div className="v">{now}</div>
            {nowUnit && <div className="u">{nowUnit}</div>}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/* ── Breakdown bars ──────────────────────────────────────── */
const BD_META = [
  { key: 'db',      name: 'База данных', color: '#1d4ed8' },
  { key: 'async',   name: 'Async',       color: '#0d9488' },
  { key: 'http',    name: 'HTTP',        color: '#06b6d4' },
  { key: 'compute', name: 'Вычисления',  color: '#7c3aed' },
  { key: 'wait',    name: 'Ожидание',    color: '#d97706' },
]

function BreakdownBars({ rt }: { rt: Metrics['responseTime'] }) {
  const items = BD_META.map(m => ({ ...m, val: rt[m.key as keyof typeof rt] as number }))
  const total = items.reduce((a, b) => a + b.val, 0)
  const max   = Math.max(...items.map(i => i.val), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }}>{Math.round(total)}</span>
        <span style={{ fontSize: 14, color: 'var(--c-text-3)', fontWeight: 600 }}>ms суммарно</span>
      </div>
      <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', gap: 2 }}>
        {items.map(it => (
          <span key={it.key} title={`${it.name}: ${Math.round(it.val)}ms`}
            style={{ width: `${(it.val / total) * 100}%`, background: it.color,
              transition: 'width 0.8s cubic-bezier(0.2,0.8,0.2,1)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 2 }}>
        {items.map(it => (
          <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span className="dot" style={{ background: it.color, width: 9, height: 9, flexShrink: 0 }} />
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--c-text-2)', width: 90 }}>{it.name}</span>
            <div style={{ flex: 1, height: 6, background: 'var(--c-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${(it.val / max) * 100}%`,
                background: it.color, borderRadius: 99, transition: 'width 0.8s cubic-bezier(0.2,0.8,0.2,1)' }} />
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 750, width: 54, textAlign: 'right',
              fontVariantNumeric: 'tabular-nums', color: it.color }}>{Math.round(it.val)} ms</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Section header ──────────────────────────────────────── */
function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="pf-section-head pf-anim">
      <span className="pf-eyebrow">{eyebrow}</span>
      <span className="pf-section-title">{title}</span>
      {sub && <span className="pf-section-sub">{sub}</span>}
    </div>
  )
}

/* ── AI report card ──────────────────────────────────────── */
function AiReport() {
  const [report, setReport] = useState<{ text: string; generatedAt: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [err, setErr] = useState('')

  const formatReport = (text: string) =>
    text.split('\n').map((line, i) => {
      const bold = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      if (line.startsWith('**') && line.endsWith('**'))
        return <div key={i} style={{ fontWeight: 700, fontSize: 14, color: 'var(--c-text)', marginTop: i ? 14 : 0 }}>{line.slice(2, -2)}</div>
      if (!line.trim()) return <div key={i} style={{ height: 6 }} />
      return <div key={i} style={{ fontSize: 13.5, color: 'var(--c-text-2)', lineHeight: 1.65 }}
        dangerouslySetInnerHTML={{ __html: bold }} />
    })

  const handleClick = async () => {
    setLoading(true); setErr('')
    try {
      const res = await getPlatformReport()
      setReport({ text: res.report, generatedAt: res.generatedAt })
      toast.success('Отчёт получен')
    } catch (e: any) {
      const msg = e.response?.data?.error || 'Ошибка'
      const w = e.response?.data?.waitMs || 0
      if (w > 0) setCooldown(Math.ceil(w / 60_000))
      setErr(msg)
    } finally { setLoading(false) }
  }

  return (
    <div className="pf-ai pf-anim" style={{ marginTop: 24, animationDelay: '0.06s', flexDirection: 'column', gap: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <span className="pf-ai-ico"><Zap size={24} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 750 }}>Краткий отчёт ИИ</div>
          <p style={{ fontSize: 14, color: 'var(--c-text-2)', marginTop: 3, lineHeight: 1.5 }}>
            Анализ метрик с рекомендациями по производительности
          </p>
        </div>
        <button className="btn btn-primary" onClick={handleClick} disabled={loading}>
          {loading
            ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Анализирую...</>
            : <><Zap size={16} /> Получить отчёт</>
          }
        </button>
      </div>

      {err && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, padding: '10px 14px', borderRadius: 10,
          background: '#fef2f2', border: '1px solid #fecaca' }}>
          <AlertTriangle size={15} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 13, color: '#dc2626' }}>{err}{cooldown > 0 ? ` (повтор через ${cooldown} мин.)` : ''}</span>
        </div>
      )}

      {report && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--c-primary-muted)', paddingTop: 16 }}>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-3)', marginBottom: 10 }}>
            Сгенерировано {new Date(report.generatedAt).toLocaleString('ru-RU')} · claude-sonnet-4-6
          </div>
          <div style={{ background: 'rgba(255,255,255,0.7)', borderRadius: 12, padding: '16px 18px' }}>
            {formatReport(report.text)}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Main ─────────────────────────────────────────────────── */
export default function PlatformTab() {
  const qc = useQueryClient()
  const [rangeKey, setRangeKey] = useState('24ч')
  const [spinning, setSpinning] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['platform-status'],
    queryFn: getPlatformStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  const enabled: boolean = data?.enabled ?? false
  const status: string   = data?.status  ?? 'disconnected'
  const metrics: Metrics | null = data?.metrics ?? null

  const range = RANGES.find(r => r.key === rangeKey) ?? RANGES[2]

  const sliceEnd = (arr: any[]) => arr.slice(-range.pts)

  /* derived series */
  const rtSeries   = useMemo(() => sliceEnd(metrics?.timeseries.responseTime ?? []), [metrics, rangeKey])
  const thSeries   = useMemo(() => sliceEnd(metrics?.timeseries.throughput ?? []),   [metrics, rangeKey])
  const erSeries   = useMemo(() => sliceEnd(metrics?.timeseries.errors ?? []),       [metrics, rangeKey])
  const fsSeries   = useMemo(() => sliceEnd(metrics?.timeseries.fetchedDoc ?? []),   [metrics, rangeKey])

  const thData     = thSeries.map((p: THPoint)  => p.rpm)
  const dbData     = rtSeries.map((p: RTPoint)  => p.db)
  const erData     = erSeries.map((p: ERPoint)  => p.count)
  const fsData     = fsSeries.map((p: FSPoint)  => p.kb)

  const n = Math.max(thData.length, dbData.length, 2)
  const xl = xLabels(n, rangeKey)

  /* stacked area breakdown series */
  const stackedSeries = BD_META.map(m => ({
    key: m.key, name: m.name, color: m.color,
    data: rtSeries.map((p: RTPoint) => p[m.key as keyof RTPoint] as number),
  }))

  const totalNow = metrics ? Math.round(metrics.responseTime.total) : 0
  const thruNow  = metrics ? Math.round(metrics.throughput) : 0
  const dbNow    = metrics ? Math.round(metrics.responseTime.db) : 0
  const errNow   = metrics ? metrics.errorRate : 0

  const refresh = () => {
    setSpinning(true)
    qc.invalidateQueries({ queryKey: ['platform-status'] })
    setTimeout(() => setSpinning(false), 700)
  }

  /* status banner config */
  const statusCfg: Record<string, { cls: string; icon: any; title: string; sub: string }> = {
    ok:           { cls: '',     icon: CheckCircle,   title: 'Работает нормально', sub: 'Все сервисы доступны' },
    degraded:     { cls: 'warn', icon: Activity,      title: 'Замедление',         sub: 'Время ответа выше нормы' },
    overloaded:   { cls: 'down', icon: AlertTriangle, title: 'Перегружена',        sub: 'Критические значения метрик' },
    disconnected: { cls: 'warn', icon: WifiOff,       title: 'Нет соединения',     sub: 'Данные не поступают' },
  }
  const sc = statusCfg[status] ?? statusCfg.disconnected
  const StatusIcon = sc.icon

  if (!enabled) return (
    <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--c-text-3)' }}>
      <WifiOff size={40} style={{ marginBottom: 14, opacity: 0.4 }} />
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-2)', marginBottom: 8 }}>Мониторинг не настроен</div>
      <div style={{ fontSize: 13.5 }}>Добавьте в <code style={{ background: 'var(--c-surface-2)', padding: '1px 7px', borderRadius: 5 }}>.env</code>:</div>
      <code style={{ display: 'block', marginTop: 12, padding: '12px 18px', background: 'var(--c-surface-2)',
        borderRadius: 10, fontSize: 13, textAlign: 'left', maxWidth: 380, margin: '12px auto 0', lineHeight: 1.8 }}>
        MONTI_APP_ID=...<br />MONTI_RESUME_TOKEN=...
      </code>
    </div>
  )

  const updTime = metrics?.updatedAt
    ? new Date(metrics.updatedAt).toLocaleTimeString('ru-RU')
    : null

  return (
    <div className="pf">

      {/* ── Status banner ── */}
      <div className={`pf-status pf-anim ${sc.cls}`}>
        <span className="pf-status-orb">
          <span className="pf-pulse"><StatusIcon size={26} /></span>
        </span>
        <div>
          <div className="pf-status-title">{sc.title}</div>
          <div className="pf-status-sub">
            {sc.sub}{updTime ? ` · обновлено в ${updTime}` : ''}
          </div>
        </div>
        <div className="pf-toolbar">
          <span className="pf-live"><span className="dot" />live</span>
          <div className="segmented">
            {RANGES.map(r => (
              <button key={r.key} className={r.key === rangeKey ? 'active' : ''} onClick={() => setRangeKey(r.key)}>
                {r.key}
              </button>
            ))}
          </div>
          <button className={`pf-refresh ${spinning ? 'spin' : ''}`} onClick={refresh}>
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {/* ── KPI cards ── */}
      <div className="pf-grid pf-grid-4" style={{ marginTop: 4 }}>
        <KpiCard delay={0.04} icon={Activity}       color="#1d4ed8" bg="#eff4ff"
          label="Throughput" value={String(thruNow)} unit="rpm" spark={thData} trend={thData} />
        <KpiCard delay={0.10} icon={Clock}           color="#0d9488" bg="#effcf9"
          label="Время ответа" value={String(totalNow)} unit="ms" spark={dbData.map((d,i) => d + (rtSeries[i]?.compute ?? 0) + (rtSeries[i]?.async ?? 0))} trend={dbData} />
        <KpiCard delay={0.16} icon={Database}        color="#7c3aed" bg="#f5f3ff"
          label="БД (db)" value={String(dbNow)} unit="ms" spark={dbData} trend={dbData} />
        <KpiCard delay={0.22} icon={AlertTriangle}
          color={errNow > 0.5 ? '#dc2626' : '#16a34a'} bg={errNow > 0.5 ? '#fef2f2' : '#f0fdf4'}
          label="Ошибки" value={errNow.toFixed(1)} unit="%" spark={erData.length ? erData : undefined} />
      </div>

      {/* ── Методы ── */}
      <div className="pf-section">
        <SectionHead eyebrow="Производительность" title="Методы" sub={range.label} />

        <div className="pf-grid pf-grid-21">
          <ChartCard delay={0.04} icon={Activity} iconColor="#1d4ed8"
            title="Запросов в минуту" sub="methodThroughput"
            now={String(thruNow)} nowUnit="rpm сейчас">
            {thData.length > 1
              ? <LineChart data={thData} color="#1d4ed8" height={230} unit="rpm" xLabels={xl} />
              : <EmptyChart height={230} />}
          </ChartCard>

          <ChartCard delay={0.10} title="Разбивка времени ответа" sub="responseTimeBreakdown · сейчас">
            {metrics ? <BreakdownBars rt={metrics.responseTime} /> : <EmptyChart height={200} />}
          </ChartCard>
        </div>

        <div className="pf-grid pf-grid-2" style={{ marginTop: 14 }}>
          <ChartCard delay={0.04} icon={Activity} iconColor="#0d9488"
            title="Время ответа по слоям" sub="db · async · http · вычисления · ожидание"
            now={String(totalNow)} nowUnit="ms среднее">
            {stackedSeries[0]?.data.length > 1
              ? <>
                  <StackedArea series={stackedSeries} height={230} unit="ms" xLabels={xl} />
                  <div className="pf-legend">
                    {stackedSeries.map(s => (
                      <span className="pf-legend-item" key={s.key}>
                        <span className="sw" style={{ background: s.color }} />{s.name}
                        <span className="lv">{Math.round(avg(s.data))}ms</span>
                      </span>
                    ))}
                  </div>
                </>
              : <EmptyChart height={230} />}
          </ChartCard>

          <ChartCard delay={0.10} icon={AlertTriangle} iconColor="#dc2626"
            title="Количество ошибок" sub="methodErrors"
            now={erData.length ? String(erData.reduce((a, b) => a + b, 0)) : '—'} nowUnit="за период">
            {erData.length > 1
              ? <LineChart data={erData} color="#dc2626" height={230} yMin={0} xLabels={xl} />
              : <EmptyChart height={230} />}
          </ChartCard>
        </div>

        {fsData.length > 1 && (
          <div className="pf-grid pf-grid-2" style={{ marginTop: 14 }}>
            <ChartCard delay={0.04} icon={Database} iconColor="#1d4ed8"
              title="Размер данных из БД" sub="avgFetchedDocSize"
              now={metrics ? f1(metrics.fetchedDocKb) : '—'} nowUnit="КБ среднее">
              <LineChart data={fsData} color="#1d4ed8" height={190} fmt={v => f1(v)} unit="КБ" grid={3} xLabels={xl} />
            </ChartCard>
            <ChartCard delay={0.10} icon={Send} iconColor="#0d9488"
              title="БД: время запроса" sub="db response timeseries"
              now={String(dbNow)} nowUnit="ms среднее">
              <LineChart data={dbData} color="#7c3aed" height={190} unit="ms" grid={3} xLabels={xl} />
            </ChartCard>
          </div>
        )}
      </div>

      {/* ── AI brief ── */}
      <AiReport />
    </div>
  )
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--c-text-3)', fontSize: 13 }}>
      Недостаточно данных
    </div>
  )
}
