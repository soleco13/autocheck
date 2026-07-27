import { useRef, useState, useEffect } from 'react'

/* ── ResizeObserver hook ─────────────────────────────────── */
export function useChartWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const update = () => setW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function useMounted(delay = 70) {
  const [m, setM] = useState(false)
  useEffect(() => { const t = setTimeout(() => setM(true), delay); return () => clearTimeout(t) }, [])
  return m
}

/* ── Catmull-Rom → cubic-bezier smooth path ─────────────── */
export function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return d
}

let gradSeq = 0

interface XLabel { i: number; label: string }

/* ── LineChart ──────────────────────────────────────────── */
interface LineChartProps {
  data: number[]
  color?: string
  height?: number
  area?: boolean
  yMin?: number
  yMax?: number
  fmt?: (v: number) => string
  unit?: string
  xLabels?: XLabel[]
  grid?: number
  pad?: { t: number; r: number; b: number; l: number }
}

export function LineChart({
  data, color = '#1d4ed8', height = 210, area = true,
  yMin, yMax, fmt = v => String(Math.round(v)), unit = '',
  xLabels, grid = 4,
  pad = { t: 16, r: 14, b: 26, l: 46 },
}: LineChartProps) {
  const [ref, w] = useChartWidth()
  const mounted = useMounted()
  const [hover, setHover] = useState<number | null>(null)
  const gid = useRef('pfg' + gradSeq++)

  if (!data.length) return <div ref={ref} style={{ width: '100%', height }} />

  const dmin = yMin ?? Math.min(...data)
  let dmax = yMax ?? Math.max(...data)
  const span = dmax - dmin || 1
  dmax = dmax + span * 0.12
  const lo = dmin - (yMin != null ? 0 : span * 0.05)

  const iW = Math.max(0, w - pad.l - pad.r)
  const iH = height - pad.t - pad.b
  const X = (i: number) => pad.l + (data.length <= 1 ? iW / 2 : (i / (data.length - 1)) * iW)
  const Y = (v: number) => pad.t + iH - ((v - lo) / (dmax - lo)) * iH

  const pts: [number, number][] = data.map((v, i) => [X(i), Y(v)])
  const line = smoothPath(pts)
  const areaD = line && pts.length > 1
    ? `${line} L ${pts[pts.length-1][0].toFixed(2)} ${(pad.t+iH).toFixed(2)} L ${pts[0][0].toFixed(2)} ${(pad.t+iH).toFixed(2)} Z`
    : ''
  const gridVals = Array.from({ length: grid + 1 }, (_, i) => lo + ((dmax - lo) * i) / grid)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!w || data.length < 2) return
    const rect = e.currentTarget.getBoundingClientRect()
    let idx = Math.round(((e.clientX - rect.left - pad.l) / iW) * (data.length - 1))
    setHover(Math.max(0, Math.min(data.length - 1, idx)))
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ display: 'block', overflow: 'visible' }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={gid.current} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.20} />
              <stop offset="100%" stopColor={color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          {gridVals.map((gv, i) => (
            <g key={i}>
              <line x1={pad.l} x2={w-pad.r} y1={Y(gv)} y2={Y(gv)}
                stroke="var(--c-border-solid)" strokeWidth={1}
                strokeDasharray={i === 0 ? '0' : '3 4'} opacity={i === 0 ? 0.9 : 0.6} />
              <text x={pad.l-10} y={Y(gv)} textAnchor="end" dominantBaseline="middle"
                fontSize={11.5} fontWeight={600} fill="var(--c-text-3)">{fmt(gv)}</text>
            </g>
          ))}
          {xLabels?.map((xl, i) => (
            <text key={i} x={X(xl.i)} y={height-6}
              textAnchor={i === 0 ? 'start' : i === xLabels.length-1 ? 'end' : 'middle'}
              fontSize={11.5} fontWeight={600} fill="var(--c-text-3)">{xl.label}</text>
          ))}
          {area && areaD && (
            <path d={areaD} fill={`url(#${gid.current})`}
              style={{ opacity: mounted ? 1 : 0, transition: 'opacity 0.7s ease 0.3s' }} />
          )}
          {line && (
            <path d={line} fill="none" stroke={color} strokeWidth={2.5}
              strokeLinejoin="round" strokeLinecap="round" pathLength={1}
              style={{ strokeDasharray: 1, strokeDashoffset: mounted ? 0 : 1,
                transition: 'stroke-dashoffset 1.1s cubic-bezier(0.4,0,0.2,1)' }} />
          )}
          {hover != null && (
            <g>
              <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t+iH}
                stroke={color} strokeWidth={1.5} opacity={0.35} />
              <circle cx={X(hover)} cy={Y(data[hover])} r={5.5} fill="#fff" stroke={color} strokeWidth={2.5} />
            </g>
          )}
        </svg>
      )}
      {hover != null && (
        <div className="pf-tip" style={{ left: X(hover), top: Y(data[hover]) }}>
          <span className="tv">{fmt(data[hover])}</span>{unit ? ' ' + unit : ''}
        </div>
      )}
    </div>
  )
}

/* ── Sparkline ──────────────────────────────────────────── */
export function Sparkline({ data, color = '#1d4ed8', height = 46 }: { data: number[]; color?: string; height?: number }) {
  const [ref, w] = useChartWidth()
  const mounted = useMounted()
  const gid = useRef('pfs' + gradSeq++)

  if (!data.length) return <div ref={ref} style={{ width: '100%', height }} />
  const min = Math.min(...data), max = Math.max(...data)
  const sp = max - min || 1
  const pad = 3
  const X = (i: number) => data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w
  const Y = (v: number) => pad + (height - pad * 2) - ((v - min) / sp) * (height - pad * 2)
  const pts: [number, number][] = data.map((v, i) => [X(i), Y(v)])
  const line = smoothPath(pts)
  const areaD = line && pts.length > 1
    ? `${line} L ${pts[pts.length-1][0].toFixed(2)} ${height} L ${pts[0][0].toFixed(2)} ${height} Z`
    : ''

  return (
    <div ref={ref} style={{ width: '100%', height }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ display: 'block' }}>
          <defs>
            <linearGradient id={gid.current} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {areaD && <path d={areaD} fill={`url(#${gid.current})`}
            style={{ opacity: mounted ? 1 : 0, transition: 'opacity 0.6s ease 0.2s' }} />}
          {line && (
            <path d={line} fill="none" stroke={color} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" pathLength={1}
              style={{ strokeDasharray: 1, strokeDashoffset: mounted ? 0 : 1,
                transition: 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' }} />
          )}
        </svg>
      )}
    </div>
  )
}

/* ── StackedArea ────────────────────────────────────────── */
interface StackedSeries { key: string; name: string; color: string; data: number[] }
interface StackedAreaProps {
  series: StackedSeries[]
  height?: number
  fmt?: (v: number) => string
  unit?: string
  xLabels?: XLabel[]
  grid?: number
  pad?: { t: number; r: number; b: number; l: number }
}

export function StackedArea({
  series, height = 240, fmt = v => String(Math.round(v)), unit = '',
  xLabels, grid = 4,
  pad = { t: 16, r: 14, b: 26, l: 46 },
}: StackedAreaProps) {
  const [ref, w] = useChartWidth()
  const mounted = useMounted()
  const [hover, setHover] = useState<number | null>(null)
  const n = series[0]?.data.length ?? 0

  if (!n) return <div ref={ref} style={{ width: '100%', height }} />

  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + s.data[i], 0))
  const dmax = Math.max(...totals) * 1.1 || 1
  const iW = Math.max(0, w - pad.l - pad.r)
  const iH = height - pad.t - pad.b
  const X = (i: number) => pad.l + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW)
  const Y = (v: number) => pad.t + iH - (v / dmax) * iH
  const gridVals = Array.from({ length: grid + 1 }, (_, i) => (dmax * i) / grid)

  let cum = new Array(n).fill(0)
  const layers = series.map(s => {
    const lower = cum.slice()
    const upper = cum.map((c, i) => c + s.data[i])
    cum = upper
    return { color: s.color, name: s.name, lower, upper }
  })

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!w) return
    const rect = e.currentTarget.getBoundingClientRect()
    let idx = Math.round(((e.clientX - rect.left - pad.l) / iW) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, idx)))
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ display: 'block', overflow: 'visible' }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {gridVals.map((gv, i) => (
            <g key={i}>
              <line x1={pad.l} x2={w-pad.r} y1={Y(gv)} y2={Y(gv)} stroke="var(--c-border-solid)"
                strokeWidth={1} strokeDasharray={i === 0 ? '0' : '3 4'} opacity={i === 0 ? 0.9 : 0.6} />
              <text x={pad.l-10} y={Y(gv)} textAnchor="end" dominantBaseline="middle"
                fontSize={11.5} fontWeight={600} fill="var(--c-text-3)">{fmt(gv)}</text>
            </g>
          ))}
          {xLabels?.map((xl, i) => (
            <text key={i} x={X(xl.i)} y={height-6}
              textAnchor={i === 0 ? 'start' : i === xLabels.length-1 ? 'end' : 'middle'}
              fontSize={11.5} fontWeight={600} fill="var(--c-text-3)">{xl.label}</text>
          ))}
          {layers.map((ly, li) => {
            const up: [number, number][] = ly.upper.map((v, i) => [X(i), Y(v)])
            const lo = ly.lower.map((v, i): [number, number] => [X(i), Y(v)]).reverse()
            const top = smoothPath(up)
            const bot = lo.map(p => `L ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ')
            return (
              <path key={li} d={`${top} ${bot} Z`} fill={ly.color} fillOpacity={0.82}
                stroke={ly.color} strokeWidth={0.6}
                style={{ opacity: mounted ? 1 : 0, transition: `opacity 0.6s ease ${0.15 + li * 0.08}s` }} />
            )
          })}
          {hover != null && (
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t+iH}
              stroke="var(--c-text)" strokeWidth={1.5} opacity={0.25} />
          )}
        </svg>
      )}
      {hover != null && (
        <div className="pf-tip" style={{ left: X(hover), top: Y(totals[hover]) }}>
          <span className="tv">{fmt(totals[hover])}</span>{unit ? ' ' + unit : ''}
        </div>
      )}
    </div>
  )
}
