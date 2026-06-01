import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Users, CheckCircle, Target, Hourglass, Zap, TrendingUp, History as HistoryIcon, Play } from 'lucide-react'
import { getStudents, getAiUsage } from '../api/client'
import api from '../api/client'
import { Donut, HBars } from '../components/Charts'
import { GradeBadge, StatusBadge } from '../components/StatusBadge'

function formatDate(ts: string | null) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '—' }
}

const getRecentHistory = () =>
  api.get('/reports/history', { params: { page: '1', pageSize: '4' } }).then(r => r.data)
    .catch(() => ({ reports: [], pagination: { total: 0 } }))


function SkelLine({ w = '100%', h = 14, mb = 0 }: { w?: string | number; h?: number; mb?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, marginBottom: mb }} />
}

function StatCard({ icon, iconBg, iconColor, label, value, sub, trend, loading }: {
  icon: React.ReactNode; iconBg: string; iconColor: string
  label: string; value: React.ReactNode; sub?: string
  trend?: { up: boolean; value: string }; loading?: boolean
}) {
  return (
    <div className="stat-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="stat-icon" style={{ background: iconBg, color: iconColor }}>{icon}</div>
        {trend && !loading && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 700, color: trend.up ? 'var(--c-success)' : 'var(--c-danger)' }}>
            <TrendingUp size={15} style={{ transform: trend.up ? 'none' : 'scaleY(-1)' }} />{trend.value}
          </span>
        )}
      </div>
      {loading ? (
        <><SkelLine w={80} h={30} mb={8} /><SkelLine w={120} h={13} /></>
      ) : (
        <>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.025em', lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 14.5, color: 'var(--c-text-2)', marginTop: 7, fontWeight: 550 }}>{label}</div>
          {sub && <div style={{ fontSize: 13, color: 'var(--c-text-3)', marginTop: 2 }}>{sub}</div>}
        </>
      )}
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const [loadingDelay, setLoadingDelay] = useState(true)
  useEffect(() => { const t = setTimeout(() => setLoadingDelay(false), 650); return () => clearTimeout(t) }, [])

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['students'],
    queryFn: () => getStudents(),
    staleTime: 60_000,
  })

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['history-recent'],
    queryFn: getRecentHistory,
    staleTime: 30_000,
  })

  const { data: usageData } = useQuery({
    queryKey: ['aiUsage'],
    queryFn: getAiUsage,
    staleTime: 60_000,
  })

  const recentReports: any[] = historyData?.reports ?? []
  const totalReports: number = historyData?.pagination?.total ?? 0
  const totalStudents = (students as any[]).length
  const loading = loadingDelay || studentsLoading || historyLoading

  // Compute grade distribution from recent reports
  const gradeDist = (() => {
    const counts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0 }
    for (const r of recentReports) {
      const g = Number(r.report_grade)
      if (g >= 2 && g <= 5) counts[g]++
    }
    return [
      { mark: '5', count: counts[5], color: '#16a34a' },
      { mark: '4', count: counts[4], color: '#1d4ed8' },
      { mark: '3', count: counts[3], color: '#d97706' },
      { mark: '2', count: counts[2], color: '#dc2626' },
    ].filter(g => g.count > 0)
  })()

  const totalGrades = gradeDist.reduce((a, g) => a + g.count, 0)

  // API credits
  const usage = usageData as any
  const creditUsed = (usage?.total?.inputTokens ?? 0) + (usage?.total?.outputTokens ?? 0)
  const creditMax = 10_000_000
  const creditPct = Math.round((creditUsed / creditMax) * 100)

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Главная</h1>
          <p className="page-subtitle">Сводка по вашим ученикам</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => navigate('/history')}>
            <HistoryIcon size={17} /> Вся история
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/students')}>
            <Play size={16} /> Проверить работы
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, marginBottom: 18 }}>
        <StatCard loading={loading} icon={<Users size={22} />} iconBg="#eff4ff" iconColor="#1d4ed8"
          label="Учеников всего" value={totalStudents} sub="по всем направлениям" trend={{ up: true, value: '+3' }} />
        <StatCard loading={loading} icon={<CheckCircle size={22} />} iconBg="#f0fdf4" iconColor="#16a34a"
          label="Работ проверено" value={totalReports} sub="за всё время" trend={{ up: true, value: '+12' }} />
        <StatCard loading={loading} icon={<Target size={22} />} iconBg="#effcf9" iconColor="#0d9488"
          label="Средний результат"
          value={recentReports.length > 0
            ? Math.round(recentReports.filter(r => r.percentage != null).reduce((a, r) => a + Number(r.percentage), 0) / (recentReports.filter(r => r.percentage != null).length || 1)) + '%'
            : '—'}
          sub="по последним проверкам" trend={{ up: true, value: '+2%' }} />
        <StatCard loading={loading} icon={<Hourglass size={22} />} iconBg="#fffaeb" iconColor="#d97706"
          label="Требуют внимания"
          value={recentReports.filter(r => r.status === 'manual_required').length}
          sub="ручная проверка" />
      </div>

      {/* Main row: tokens + grade distribution + recent checks */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr', gap: 18 }}>
        {/* API credits card */}
        <div className="card card-pad">
          <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>Токены ИИ</h3>
          <p style={{ fontSize: 13.5, color: 'var(--c-text-3)', marginBottom: 22 }}>Расход API за период</p>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[1, 2, 3].map(i => <SkelLine key={i} w="100%" h={12} />)}
            </div>
          ) : (
            <HBars data={[
              { name: 'Вход', value: usage?.total?.inputTokens ?? 0, color: 'var(--c-primary)' },
              { name: 'Выход', value: usage?.total?.outputTokens ?? 0, color: 'var(--c-teal)' },
              { name: 'Запросы', value: usage?.total?.totalCalls ?? 0, color: '#7c3aed' },
            ]} />
          )}
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--c-border-solid)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 9 }}>
              <span style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Zap size={16} color="#0d9488" /> Токены использовано
              </span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{creditUsed.toLocaleString('ru')}</span>
            </div>
            <div className="progress-bar" style={{ height: 8 }}>
              <div className="progress-bar-fill teal" style={{ width: `${Math.min(100, creditPct)}%` }} />
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', marginTop: 8 }}>
              Всего токенов: {creditMax.toLocaleString('ru')}
            </div>
          </div>
        </div>

        {/* Grade distribution */}
        <div className="card card-pad">
          <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>Распределение оценок</h3>
          <p style={{ fontSize: 13.5, color: 'var(--c-text-3)', marginBottom: 18 }}>По последним проверкам</p>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}><SkelLine w={140} h={140} /></div>
          ) : totalGrades === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--c-text-3)', fontSize: 14 }}>Нет данных</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
              <Donut size={140} thickness={20} data={gradeDist.map(g => ({ value: g.count, color: g.color }))} centerLabel={totalGrades} centerSub="оценок" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, width: '100%' }}>
                {gradeDist.map(g => (
                  <div key={g.mark} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="dot" style={{ background: g.color, width: 9, height: 9, flexShrink: 0 }} />
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>Оценка {g.mark}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 700, color: 'var(--c-text-2)' }}>{g.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent checks */}
        <div className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '20px 24px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 17, fontWeight: 700 }}>Последние проверки</h3>
              <p style={{ fontSize: 13.5, color: 'var(--c-text-3)', marginTop: 2 }}>Недавно завершённые работы</p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/history')}>Все →</button>
          </div>
          <div className="divider" />
          {loading ? (
            <div style={{ padding: 8 }}>{[1, 2, 3, 4, 5].map(i => <div key={i} style={{ padding: 14 }}><SkelLine w="60%" h={13} /></div>)}</div>
          ) : recentReports.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--c-text-3)', fontSize: 14 }}>
              Проверок ещё нет
            </div>
          ) : recentReports.map((r: any, i: number) => {
            const initials = (r.student_name || '?').split(' ').map((w: string) => w[0]).slice(0, 2).join('')
            const pct = r.percentage != null ? Math.round(Number(r.percentage)) : null
            return (
              <button key={r.id} onClick={() => navigate(`/reports/${r.id}`)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 24px', background: 'none', border: 'none',
                  borderTop: i > 0 ? '1px solid var(--c-border-solid)' : 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                <div className="avatar" style={{ width: 38, height: 38, fontSize: 14, flexShrink: 0 }}>{initials}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.student_name || '—'}</div>
                  <div style={{ fontSize: 13, color: 'var(--c-text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title || 'Без названия'}</div>
                </div>
                <StatusBadge status={r.status || 'completed'} />
                {pct != null && (
                  <div style={{ width: 46, textAlign: 'right', fontSize: 15, fontWeight: 700, color: pct >= 70 ? 'var(--c-success)' : pct >= 50 ? 'var(--c-warn)' : 'var(--c-danger)', flexShrink: 0 }}>
                    {pct}%
                  </div>
                )}
                {r.report_grade && <GradeBadge grade={r.report_grade} />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
