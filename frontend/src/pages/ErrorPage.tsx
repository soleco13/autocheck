import { Home, ArrowLeft, RefreshCw, Clock } from 'lucide-react'

interface ErrorConfig {
  title: string
  subtitle: string
  action?: { label: string; icon: React.ReactNode }
}

const ERROR_CONFIG: Record<number, ErrorConfig> = {
  404: {
    title: 'Страница не найдена',
    subtitle: 'Такой страницы не существует или она была перемещена.\nПроверьте адрес или вернитесь на главную.',
  },
  403: {
    title: 'Нет доступа',
    subtitle: 'У вас нет прав для просмотра этой страницы.\nОбратитесь к администратору, если считаете это ошибкой.',
  },
  429: {
    title: 'Слишком много запросов',
    subtitle: 'Вы отправили слишком много запросов за короткое время.\nПодождите немного и попробуйте снова.',
    action: { label: 'Подождать и обновить', icon: <Clock size={16} /> },
  },
  500: {
    title: 'Ошибка сервера',
    subtitle: 'На сервере произошла непредвиденная ошибка.\nМы уже работаем над её устранением.',
    action: { label: 'Обновить страницу', icon: <RefreshCw size={16} /> },
  },
  503: {
    title: 'Сервис недоступен',
    subtitle: 'Сервис временно недоступен — возможно, идёт техническое обслуживание.\nПопробуйте зайти через несколько минут.',
    action: { label: 'Попробовать снова', icon: <RefreshCw size={16} /> },
  },
}

const KEYFRAMES = `
  @keyframes ep-float {
    0%, 100% { transform: translateY(0px) rotate(-1deg); }
    50%       { transform: translateY(-14px) rotate(1deg); }
  }
  @keyframes ep-fade-up {
    from { opacity: 0; transform: translateY(22px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ep-blob-1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    40%      { transform: translate(30px, -20px) scale(1.08); }
    70%      { transform: translate(-20px, 15px) scale(0.94); }
  }
  @keyframes ep-blob-2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    35%      { transform: translate(-25px, 20px) scale(1.06); }
    65%      { transform: translate(18px, -12px) scale(0.96); }
  }
  @keyframes ep-ring-pulse {
    0%, 100% { transform: scale(1);    opacity: 0.18; }
    50%      { transform: scale(1.08); opacity: 0.08; }
  }
  @keyframes ep-ring-pulse-2 {
    0%, 100% { transform: scale(1);    opacity: 0.10; }
    50%      { transform: scale(1.12); opacity: 0.04; }
  }
  @keyframes ep-q1 {
    0%, 100% { transform: translateY(0) rotate(-8deg);  opacity: 0.55; }
    50%      { transform: translateY(-16px) rotate(4deg); opacity: 0.9; }
  }
  @keyframes ep-q2 {
    0%, 100% { transform: translateY(0) rotate(10deg);  opacity: 0.45; }
    50%      { transform: translateY(-10px) rotate(-5deg); opacity: 0.8; }
  }
  @keyframes ep-q3 {
    0%, 100% { transform: translateY(0) rotate(-4deg); opacity: 0.35; }
    50%      { transform: translateY(-18px) rotate(7deg); opacity: 0.7; }
  }
  @keyframes ep-dot-orbit {
    from { transform: rotate(0deg) translateX(140px) rotate(0deg); }
    to   { transform: rotate(360deg) translateX(140px) rotate(-360deg); }
  }
  @keyframes ep-dot-orbit-rev {
    from { transform: rotate(0deg) translateX(110px) rotate(0deg); }
    to   { transform: rotate(-360deg) translateX(110px) rotate(360deg); }
  }
  .ep-btn-primary {
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .ep-btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(29, 78, 216, 0.3);
  }
  .ep-btn-ghost {
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .ep-btn-ghost:hover {
    transform: translateY(-2px);
  }
`

interface Props { code?: number }

export default function ErrorPage({ code = 404 }: Props) {
  const cfg = ERROR_CONFIG[code] ?? ERROR_CONFIG[404]
  const isServerError = code >= 500

  const blob1 = isServerError ? '#dc2626' : '#1d4ed8'
  const blob2 = isServerError ? '#f97316' : '#06d6c4'
  const codeColor = isServerError ? 'var(--c-danger)' : 'var(--c-primary)'

  const primaryAction = cfg.action
    ? () => window.location.reload()
    : () => { window.location.href = '/' }
  const primaryLabel = cfg.action?.label ?? 'На главную'
  const primaryIcon  = cfg.action?.icon ?? <Home size={16} />

  return (
    <>
      <style>{KEYFRAMES}</style>

      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#f6f7f9',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>

        {/* Animated blobs background */}
        <div style={{
          position: 'absolute', width: 480, height: 480,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${blob1}22 0%, transparent 70%)`,
          top: '5%', left: '5%',
          animation: 'ep-blob-1 9s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', width: 380, height: 380,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${blob2}22 0%, transparent 70%)`,
          bottom: '5%', right: '5%',
          animation: 'ep-blob-2 11s ease-in-out infinite',
          pointerEvents: 'none',
        }} />

        {/* Floating question marks — decorative */}
        <div style={{
          position: 'absolute', fontSize: 52, fontWeight: 900,
          color: blob2, lineHeight: 1,
          top: '18%', left: '14%',
          animation: 'ep-q1 3.8s ease-in-out infinite',
          userSelect: 'none', pointerEvents: 'none',
          opacity: 0.55,
        }}>?</div>
        <div style={{
          position: 'absolute', fontSize: 36, fontWeight: 900,
          color: blob1, lineHeight: 1,
          top: '12%', right: '16%',
          animation: 'ep-q2 4.5s ease-in-out infinite 0.6s',
          userSelect: 'none', pointerEvents: 'none',
          opacity: 0.45,
        }}>?</div>
        <div style={{
          position: 'absolute', fontSize: 24, fontWeight: 900,
          color: blob2, lineHeight: 1,
          bottom: '20%', left: '18%',
          animation: 'ep-q3 5s ease-in-out infinite 1.2s',
          userSelect: 'none', pointerEvents: 'none',
          opacity: 0.35,
        }}>?</div>

        {/* Center content */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          textAlign: 'center', maxWidth: 460, padding: '0 24px',
          position: 'relative', zIndex: 1,
        }}>

          {/* Character */}
          <div style={{ marginBottom: 32 }}>
            <img
              src="/i_dont_know.png"
              alt="Ошибка"
              width={300}
              height={300}
              style={{
                objectFit: 'contain',
                display: 'block',
                animation: 'ep-float 4s ease-in-out infinite',
                filter: 'drop-shadow(0 24px 36px rgba(29,78,216,0.18))',
              }}
            />
          </div>

          {/* Title */}
          <h1 style={{
            fontSize: 28, fontWeight: 800,
            color: 'var(--c-text)',
            margin: '0 0 10px',
            letterSpacing: '-0.025em',
            animation: 'ep-fade-up 0.55s ease both 0.1s',
          }}>
            {cfg.title}
          </h1>

          {/* Subtitle */}
          <p style={{
            fontSize: 15, color: 'var(--c-text-2)',
            lineHeight: 1.7, margin: '0 0 32px',
            whiteSpace: 'pre-line',
            animation: 'ep-fade-up 0.55s ease both 0.2s',
          }}>
            {cfg.subtitle}
          </p>

          {/* Buttons */}
          <div style={{
            display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center',
            animation: 'ep-fade-up 0.55s ease both 0.3s',
          }}>
            <button
              className="btn btn-primary ep-btn-primary"
              onClick={primaryAction}
              style={{ gap: 8, paddingLeft: 22, paddingRight: 22 }}
            >
              {primaryIcon}
              {primaryLabel}
            </button>
            <button
              className="btn btn-ghost ep-btn-ghost"
              onClick={() => window.history.back()}
              style={{ gap: 8 }}
            >
              <ArrowLeft size={16} />
              Назад
            </button>
          </div>

          {/* Error code */}
          <p style={{
            fontSize: 12, color: 'var(--c-text-3)',
            marginTop: 32, letterSpacing: '0.05em',
            animation: 'ep-fade-up 0.55s ease both 0.4s',
          }}>
            Код ошибки:&nbsp;<strong style={{ color: codeColor }}>{code}</strong>
          </p>
        </div>
      </div>
    </>
  )
}
