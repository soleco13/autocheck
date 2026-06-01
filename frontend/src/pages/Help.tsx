import { useNavigate } from 'react-router-dom'
import { AppLogo } from '../components/AppLogo'
import {
  Users, FileText, Play, Pencil, BookMarked, Eye,
  HelpCircle, ExternalLink,
} from 'lucide-react'

const STEPS = [
  {
    icon: <Users size={20} />,
    title: 'Выберите ученика',
    text: 'Перейдите в раздел «Ученики», найдите нужного через поиск или фильтр по классу. Откройте карточку ученика.',
  },
  {
    icon: <FileText size={20} />,
    title: 'Отметьте материалы',
    text: 'В карточке ученика выберите один или несколько материалов галочками. Можно отфильтровать по предмету и статусу.',
  },
  {
    icon: <Play size={20} />,
    title: 'Запустите проверку',
    text: 'Нажмите «Проверить выбранные». Проверка идёт в фоне — вы можете перейти на другую страницу, прогресс сохранится.',
  },
  {
    icon: <FileText size={20} />,
    title: 'Откройте отчёт',
    text: 'Когда проверка завершится, откройте отчёт. По каждому заданию виден ответ ученика, эталон, балл и комментарий ИИ.',
  },
  {
    icon: <Pencil size={20} />,
    title: 'Скорректируйте баллы',
    text: 'Если нужно, измените балл по любому заданию вручную — итоговая оценка пересчитается автоматически.',
  },
  {
    icon: <BookMarked size={20} />,
    title: 'Загрузите учебники',
    text: 'В разделе «Учебники» добавьте PDF — ИИ использует их как источник эталонных ответов для более точной проверки.',
  },
]

const FAQ = [
  {
    q: 'Можно ли уйти со страницы во время проверки?',
    a: 'Да. Проверка выполняется в фоне, а её прогресс отображается в верхней панели на любой странице.',
  },
  {
    q: 'Что значит статус «Проверьте вручную»?',
    a: 'ИИ не смог однозначно оценить ответ (например, развёрнутое решение). Откройте отчёт и выставьте балл сами.',
  },
  {
    q: 'Откуда берутся эталонные ответы?',
    a: 'Из материала на платформе и загруженных вами учебников в разделе «Учебники».',
  },
  {
    q: 'Как ИИ выставляет оценку?',
    a: 'На основе процента правильных ответов: 85%+ → 5, 70%+ → 4, 50%+ → 3, ниже → 2. Балл можно скорректировать вручную в отчёте.',
  },
]

export default function Help() {
  const navigate = useNavigate()

  return (
    <div className="content-max fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Помощь</h1>
          <p className="page-subtitle">Как работать с AutoCheck</p>
        </div>
      </div>

      {/* Hero */}
      <div className="card" style={{
        marginBottom: 22, display: 'flex', alignItems: 'center', overflow: 'hidden',
        background: 'linear-gradient(120deg, var(--c-primary-light), var(--c-teal-light))',
        border: '1px solid var(--c-primary-muted)',
      }}>
        <div style={{ padding: '28px 32px', flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <AppLogo size={28} />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-primary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>AutoCheck</span>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 750, margin: '0 0 10px', letterSpacing: '-0.01em' }}>
            Проверяйте домашние работы в три клика
          </h2>
          <p style={{ fontSize: 15, color: 'var(--c-text-2)', margin: 0, maxWidth: 520, lineHeight: 1.6 }}>
            AutoCheck проверяет работы учеников с помощью ИИ, формирует подробные отчёты по заданиям и экономит часы ручной проверки.
            Ниже — короткая инструкция.
          </p>
        </div>
        <img
          src="/pers_talk.png"
          alt=""
          style={{ width: 200, height: 160, objectFit: 'contain', flexShrink: 0, marginRight: 16 }}
        />
      </div>

      {/* Steps */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 22 }}>
        {STEPS.map((s, i) => (
          <div key={i} className="card card-pad">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{
                width: 40, height: 40, borderRadius: 11,
                background: 'var(--c-primary-light)', color: 'var(--c-primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {s.icon}
              </span>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--c-text-3)' }}>Шаг {i + 1}</span>
            </div>
            <h3 style={{ fontSize: 16.5, fontWeight: 700, margin: '0 0 6px' }}>{s.title}</h3>
            <p style={{ fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}>{s.text}</p>
          </div>
        ))}
      </div>

      {/* Report illustration */}
      <div className="card card-pad" style={{ marginBottom: 22 }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 4px' }}>Как выглядит отчёт</h3>
        <p style={{ fontSize: 14, color: 'var(--c-text-3)', margin: '0 0 16px' }}>
          Каждое задание показано отдельной карточкой с цветовой меткой статуса, ответом ученика и комментарием ИИ.
        </p>
        <div style={{
          height: 200, borderRadius: 14, border: '1px solid var(--c-border-solid)',
          background: 'repeating-linear-gradient(135deg, #f1f3f6, #f1f3f6 12px, #fafbfc 12px, #fafbfc 24px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <Eye size={30} color="var(--c-text-3)" />
          <p style={{ fontSize: 13, color: 'var(--c-text-3)', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
            Пример отчёта AutoCheck
          </p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate('/history')}
          >
            <ExternalLink size={14} /> Открыть историю проверок
          </button>
        </div>
      </div>

      {/* FAQ */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 22 }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--c-border-solid)' }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Частые вопросы</h3>
        </div>
        {FAQ.map((f, i) => (
          <div key={i} style={{ padding: '18px 24px', borderTop: i > 0 ? '1px solid var(--c-border-solid)' : 'none' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <HelpCircle size={18} color="var(--c-primary)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 15.5, fontWeight: 650, marginBottom: 4 }}>{f.q}</div>
                <p style={{ fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.55, margin: 0 }}>{f.a}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Перейти к ученикам', sub: 'Список всех учеников', path: '/students', color: 'var(--c-primary)' },
          { label: 'Загрузить учебники', sub: 'PDF для эталонных ответов', path: '/textbooks', color: 'var(--c-teal)' },
          { label: 'История проверок', sub: 'Все завершённые работы', path: '/history', color: '#7c3aed' },
        ].map(link => (
          <button key={link.path} onClick={() => navigate(link.path)} className="card card-pad"
            style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--c-border-solid)', display: 'block', width: '100%', transition: 'all 0.18s' }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = 'var(--shadow-md)'; el.style.transform = 'translateY(-2px)' }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.boxShadow = ''; el.style.transform = '' }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: link.color + '18', color: link.color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
              <ExternalLink size={16} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{link.label}</div>
            <div style={{ fontSize: 13, color: 'var(--c-text-3)', marginTop: 3 }}>{link.sub}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
