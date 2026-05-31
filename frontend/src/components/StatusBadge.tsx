import { CheckCircle, AlertCircle, XCircle, Clock, Search, Minus } from 'lucide-react'

interface StatusBadgeProps {
  status: string
  size?: 'sm' | 'md'
}

const STATUS_MAP: Record<string, { label: string; cls: string; Icon: React.FC<{ size?: number }> }> = {
  correct:         { label: 'Верно',               cls: 'badge-green',  Icon: ({ size = 12 }) => <CheckCircle size={size} /> },
  partial:         { label: 'Частично',            cls: 'badge-yellow', Icon: ({ size = 12 }) => <AlertCircle size={size} /> },
  incorrect:       { label: 'Неверно',             cls: 'badge-red',    Icon: ({ size = 12 }) => <XCircle size={size} /> },
  manual_required: { label: 'Нужна проверка',      cls: 'badge-yellow', Icon: ({ size = 12 }) => <Search size={size} /> },
  pending:         { label: 'Ожидание',            cls: 'badge-gray',   Icon: ({ size = 12 }) => <Clock size={size} /> },
  error:           { label: 'Ошибка',              cls: 'badge-red',    Icon: ({ size = 12 }) => <XCircle size={size} /> },
  completed:       { label: 'Проверено',           cls: 'badge-blue',   Icon: ({ size = 12 }) => <CheckCircle size={size} /> },
  checked:         { label: 'Проверено',           cls: 'badge-blue',   Icon: ({ size = 12 }) => <CheckCircle size={size} /> },
  done:            { label: 'Выполнено',           cls: 'badge-green',  Icon: ({ size = 12 }) => <CheckCircle size={size} /> },
  inProgress:      { label: 'В процессе',          cls: 'badge-yellow', Icon: ({ size = 12 }) => <Clock size={size} /> },
  notStarted:      { label: 'Не начато',           cls: 'badge-gray',   Icon: ({ size = 12 }) => <Minus size={size} /> },
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const s = STATUS_MAP[status] || { label: status, cls: 'badge-gray', Icon: ({ size = 12 }) => <Minus size={size} /> }
  const iconSize = size === 'sm' ? 10 : 12
  return (
    <span className={`badge ${s.cls}`}>
      <s.Icon size={iconSize} />
      {s.label}
    </span>
  )
}

export function GradeBadge({ grade, size = 'md' }: { grade: string; size?: 'sm' | 'md' | 'lg' }) {
  const cls =
    grade === '5' ? 'badge-green' :
    grade === '4' ? 'badge-blue' :
    grade === '3' ? 'badge-yellow' :
    'badge-red'
  const fs = size === 'lg' ? 28 : size === 'sm' ? 11 : 13
  const px = size === 'lg' ? '12px 20px' : undefined
  return (
    <span className={`badge ${cls}`} style={{ fontWeight: 800, fontSize: fs, padding: px, borderRadius: 12 }}>
      {grade}
    </span>
  )
}
