import { useState, useEffect } from 'react'

export function BarTrend({ data, height = 160, color = 'var(--c-primary)' }: {
  data: { label: string; value: number }[]
  height?: number
  color?: string
}) {
  const max = Math.max(...data.map(d => d.value), 1)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { const t = setTimeout(() => setMounted(true), 60); return () => clearTimeout(t) }, [])
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height, paddingTop: 8 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%' }}>
          <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            <div title={String(d.value)} style={{
              width: '70%', maxWidth: 40, borderRadius: '7px 7px 3px 3px',
              height: mounted ? `${(d.value / max) * 100}%` : '0%',
              background: i === data.length - 3 ? color : 'linear-gradient(180deg, #93b4f7, #c7d7fe)',
              transition: `height 0.7s cubic-bezier(0.2,0.8,0.2,1) ${i * 0.05}s`,
              minHeight: 4,
            }} />
          </div>
          <span style={{ fontSize: 12, color: 'var(--c-text-3)', fontWeight: 600 }}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}

export function Donut({ data, size = 168, thickness = 26, centerLabel, centerSub }: {
  data: { value: number; color: string }[]
  size?: number
  thickness?: number
  centerLabel?: React.ReactNode
  centerSub?: string
}) {
  const total = data.reduce((a, d) => a + d.value, 0)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { const t = setTimeout(() => setMounted(true), 80); return () => clearTimeout(t) }, [])
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  let offset = 0
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-surface-3)" strokeWidth={thickness} />
        {data.map((d, i) => {
          const frac = total > 0 ? d.value / total : 0
          const len = mounted ? frac * circ : 0
          const seg = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={d.color} strokeWidth={thickness} strokeLinecap="butt"
              strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset}
              style={{ transition: `stroke-dasharray 0.9s cubic-bezier(0.2,0.8,0.2,1) ${i * 0.08}s` }} />
          )
          offset += len
          return seg
        })}
      </svg>
      {centerLabel != null && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }}>{centerLabel}</div>
          {centerSub && <div style={{ fontSize: 12.5, color: 'var(--c-text-3)', fontWeight: 600 }}>{centerSub}</div>}
        </div>
      )}
    </div>
  )
}

export function HBars({ data, max: maxProp }: {
  data: { name: string; value: number; color: string }[]
  max?: number
}) {
  const m = maxProp ?? Math.max(...data.map(d => d.value), 1)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { const t = setTimeout(() => setMounted(true), 60); return () => clearTimeout(t) }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 52, fontSize: 13.5, fontWeight: 600, color: 'var(--c-text-2)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
          <div style={{ flex: 1, height: 12, background: 'var(--c-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: mounted ? `${(d.value / m) * 100}%` : '0%', background: d.color, borderRadius: 99, transition: `width 0.8s cubic-bezier(0.2,0.8,0.2,1) ${i * 0.06}s` }} />
          </div>
          <span style={{ width: 36, textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: 'var(--c-text)', flexShrink: 0 }}>{d.value}</span>
        </div>
      ))}
    </div>
  )
}
