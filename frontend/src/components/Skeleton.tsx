import React from 'react'

interface SkeletonProps {
  className?: string
  width?: string | number
  height?: string | number
  style?: React.CSSProperties
}

export function Skeleton({ className = '', width, height, style }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width, height: height || '16px', ...style }}
    />
  )
}

export function SkeletonCard() {
  return (
    <div className="card p-5">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Skeleton width={44} height={44} style={{ borderRadius: '50%' }} />
        <div style={{ flex: 1 }}>
          <Skeleton height={15} width="55%" style={{ marginBottom: 8 }} />
          <Skeleton height={12} width="35%" />
        </div>
      </div>
      <Skeleton height={4} style={{ borderRadius: 99, marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Skeleton height={22} width={70} style={{ borderRadius: 99 }} />
        <Skeleton height={22} width={85} style={{ borderRadius: 99 }} />
      </div>
    </div>
  )
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="table-wrap">
      {/* Header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--c-border-solid)',
        background: '#f8fafc',
        display: 'flex', gap: 16,
      }}>
        <Skeleton height={11} width="30%" />
        <Skeleton height={11} width="10%" />
        <Skeleton height={11} width="18%" />
        <Skeleton height={11} width="12%" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            padding: '13px 16px',
            borderBottom: i < rows - 1 ? '1px solid var(--c-border-solid)' : 'none',
            display: 'flex', alignItems: 'center', gap: 16,
          }}
        >
          <Skeleton height={13} style={{ flex: 3 }} />
          <Skeleton height={13} style={{ flex: 1 }} />
          <Skeleton height={13} style={{ flex: 2 }} />
          <Skeleton height={22} width={72} style={{ borderRadius: 99, flexShrink: 0 }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonStatCards({ count = 4 }: { count?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="stat-card">
          <Skeleton height={12} width="60%" style={{ marginBottom: 10 }} />
          <Skeleton height={28} width="45%" style={{ marginBottom: 8 }} />
          <Skeleton height={11} width="70%" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonReport() {
  return (
    <div>
      <Skeleton height={14} width={160} style={{ marginBottom: 20 }} />
      <div className="card p-6 mb-5">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px', gap: 24 }}>
          <div>
            <Skeleton height={24} width="65%" style={{ marginBottom: 10 }} />
            <Skeleton height={14} width="40%" style={{ marginBottom: 22 }} />
            <Skeleton height={8} style={{ borderRadius: 99, marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              {[72, 90, 80, 110].map((w, i) => <Skeleton key={i} height={22} width={w} style={{ borderRadius: 99 }} />)}
            </div>
          </div>
          <Skeleton height={64} style={{ borderRadius: 12 }} />
        </div>
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="card mb-3" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <Skeleton width={34} height={34} style={{ borderRadius: 8, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <Skeleton height={13} width={`${50 + i * 8}%`} style={{ marginBottom: 7 }} />
              <Skeleton height={11} width="38%" />
            </div>
            <Skeleton width={52} height={24} style={{ borderRadius: 6, flexShrink: 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SkeletonDashboard({ count = 8 }: { count?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <Skeleton width={44} height={44} style={{ borderRadius: '50%' }} />
            <div style={{ flex: 1 }}>
              <Skeleton height={14} width="70%" style={{ marginBottom: 7 }} />
              <Skeleton height={11} width="40%" />
            </div>
          </div>
          <Skeleton height={4} style={{ borderRadius: 99, marginBottom: 8 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Skeleton height={11} width="35%" />
            <Skeleton height={11} width="25%" />
          </div>
        </div>
      ))}
    </div>
  )
}
