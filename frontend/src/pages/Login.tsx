import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Zap, BarChart2 } from 'lucide-react'
import { login } from '../api/client'

const CSS = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(22px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  /* Layer 1 — slides in behind white panel */
  @keyframes mascotSlide {
    from { transform: translate(-92%, -45%) translateX(260px); }
    to   { transform: translate(-92%, -45%) translateX(0); }
  }
  /* Layer 2 — fades in on top of white panel once slide is nearly done */
  @keyframes mascotFadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .l-root  { display: flex; min-height: 100vh; font-family: var(--font); position: relative; }
  .l-left  {
    flex: 0 0 52%; background: linear-gradient(155deg,#1d4ed8 0%,#1e3a8a 60%,#172a70 100%);
    display: flex; flex-direction: column; position: relative; overflow: hidden;
    padding: 32px 48px 48px;
  }
  .l-right {
    flex: 1; display: flex; align-items: center; justify-content: center;
    background: #fff; padding: 48px 32px; position: relative; z-index: 5;
  }
  .l-right-inner { width: 100%; max-width: 360px; }

  /* Layer 1: slides in, always behind white panel */
  .l-mascot-back {
    position: absolute; left: 52%; top: 50%; pointer-events: none; z-index: 2;
    animation: mascotSlide 1s cubic-bezier(0.25,1,0.5,1) 0.3s both;
  }
  /* Layer 2: fixed at final position, fades in on top when slide is ~80% done */
  .l-mascot-front {
    position: absolute; left: 52%; top: 50%; pointer-events: none; z-index: 10;
  }
  .l-mascot-front-img {
    animation: mascotFadeIn 0.55s ease 1s both; /* delay = slide_delay + 80% of slide_duration */
  }
  .l-mascot-img, .l-mascot-front-img {
    width: clamp(180px, 34vw, 430px); height: auto; display: block;
    filter: drop-shadow(0 24px 48px rgba(0,0,0,0.22));
  }

  /* Left panel entrance animations */
  .l-logo    { animation: fadeIn  0.5s ease 0.05s both; }
  .l-badge   { animation: fadeUp  0.55s cubic-bezier(0.22,1,0.36,1) 0.2s  both; }
  .l-title   { animation: fadeUp  0.55s cubic-bezier(0.22,1,0.36,1) 0.32s both; }
  .l-desc    { animation: fadeUp  0.55s cubic-bezier(0.22,1,0.36,1) 0.42s both; }
  .l-feat0   { animation: fadeUp  0.55s cubic-bezier(0.22,1,0.36,1) 0.52s both; }
  .l-feat1   { animation: fadeUp  0.55s cubic-bezier(0.22,1,0.36,1) 0.62s both; }

  /* Right panel is always solid — animate only the inner content */
  .l-right-inner { animation: fadeUp 0.55s cubic-bezier(0.22,1,0.36,1) 0.2s both; }

  /* Form field focus glow */
  .l-input:focus { border-color: #1d4ed8 !important; box-shadow: 0 0 0 3px rgba(29,78,216,0.12); }

  /* Submit button */
  .l-btn {
    width: 100%; padding: 11px 20px; background: #1d4ed8; color: #fff;
    border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 8px; letter-spacing: -0.1px;
    transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
    box-shadow: 0 1px 3px rgba(29,78,216,0.25), 0 4px 14px rgba(29,78,216,0.2);
  }
  .l-btn:hover:not(:disabled) {
    background: #1e40af;
    box-shadow: 0 2px 8px rgba(29,78,216,0.3), 0 6px 20px rgba(29,78,216,0.25);
    transform: translateY(-1px);
  }
  .l-btn:active:not(:disabled) { transform: translateY(0); box-shadow: none; }
  .l-btn:disabled { background: #93c5fd; cursor: not-allowed; box-shadow: none; }

  /* ── Tablet (≤1024px) — скрываем персонажа, уменьшаем левую панель ── */
  @media (max-width: 1024px) {
    .l-mascot-back, .l-mascot-front { display: none; }
    .l-left { flex: 0 0 44%; padding: 28px 36px 40px; }
  }

  /* ── Mobile (≤640px) — вертикальный стек, только шапка сверху ── */
  @media (max-width: 640px) {
    .l-root  { flex-direction: column; }
    .l-mascot-back, .l-mascot-front { display: none; }
    .l-left  {
      flex: none; width: 100%; min-height: unset;
      padding: 28px 24px 36px; overflow: hidden;
    }
    .l-left-bottom { display: none; }
    .l-right {
      flex: 1; padding: 32px 20px 40px;
      align-items: flex-start;
    }
    .l-right-inner { max-width: 100%; }
  }
`

export default function Login() {
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [remember, setRemember]     = useState(true)
  const [showPwd, setShowPwd]       = useState(false)
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(email, password)
      qc.setQueryData(['me'], data)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка авторизации')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{CSS}</style>

      <div className="l-root">

        {/* Layer 1: slides in from right, always behind white panel */}
        <div className="l-mascot-back"
          style={{ transform: 'translate(-92%, -45%) translateX(260px)' }}>
          <img src="/pers_hello.png" alt="" className="l-mascot-img" />
        </div>

        {/* Layer 2: fixed at final position, fades in on top of white panel */}
        <div className="l-mascot-front"
          style={{ transform: 'translate(-92%, -45%)' }}>
          <img src="/pers_hello1.png" alt="" className="l-mascot-front-img"
            style={{ opacity: 0 }} />
        </div>

        {/* ── Left panel ── */}
        <div className="l-left">

          {/* Logo */}
          <div className="l-logo" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <img src="/logo.png" alt="AutoCheck" width={36} height={36}
              style={{ objectFit: 'contain', borderRadius: 8 }} />
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 18, letterSpacing: '-0.3px' }}>
              AutoCheck
            </span>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Bottom content */}
          <div className="l-left-bottom">
            <div className="l-badge" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 100, padding: '5px 14px', marginBottom: 18,
            }}>
              <span style={{ color: '#06d6c4', fontSize: 11 }}>✦</span>
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Для учителей
              </span>
            </div>

            <h2 className="l-title" style={{
              color: '#fff', fontSize: 'clamp(20px, 2.6vw, 32px)',
              fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.5px', marginBottom: 12,
            }}>
              Проверяйте домашние<br />работы в 5 раз быстрее
            </h2>

            <p className="l-desc" style={{
              color: 'rgba(255,255,255,0.7)', fontSize: 13, lineHeight: 1.6,
              marginBottom: 24, maxWidth: 360,
            }}>
              AutoCheck распознаёт решения, сверяет их с учебником
              и формирует подробный отчёт — вам остаётся только подтвердить оценку.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="l-feat0">
                <FeatureRow icon={<Zap size={14} color="#06d6c4" />}
                  title="Мгновенная проверка" desc="Распознаём решение и оцениваем за секунды" />
              </div>
              <div className="l-feat1">
                <FeatureRow icon={<BarChart2 size={14} color="#06d6c4" />}
                  title="Аналитика по классу" desc="Видите пробелы каждого ученика наглядно" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Right panel ── */}
        <div className="l-right">
          <div className="l-right-inner">
            <h1 style={{ fontSize: 28, fontWeight: 800, color: '#101828', letterSpacing: '-0.5px', marginBottom: 6 }}>
              С возвращением
            </h1>
            <p style={{ fontSize: 14, color: '#667085', marginBottom: 32 }}>
              Войдите, чтобы продолжить проверку работ.
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* Email */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#344054', marginBottom: 6 }}>
                  Электронная почта
                </label>
                <div style={{ position: 'relative' }}>
                  <IconWrap><MailIcon /></IconWrap>
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required placeholder="teacher@school.ru"
                    className="l-input"
                    style={inputStyle}
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#344054', marginBottom: 6 }}>
                  Пароль
                </label>
                <div style={{ position: 'relative' }}>
                  <IconWrap><LockIcon /></IconWrap>
                  <input
                    type={showPwd ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)}
                    required placeholder="••••••••"
                    className="l-input"
                    style={{ ...inputStyle, paddingRight: 40 }}
                  />
                  <button type="button" onClick={() => setShowPwd(p => !p)}
                    style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      color: '#98a2b3', lineHeight: 0 }} tabIndex={-1}>
                    {showPwd ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              {/* Remember me */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: '#1d4ed8', cursor: 'pointer' }} />
                <span style={{ fontSize: 13, color: '#344054' }}>Запомнить меня</span>
              </label>

              {error && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 14px',
                  borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca' }}>
                  <AlertCircle size={15} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 13, color: '#dc2626' }}>{error}</span>
                </div>
              )}

              <button type="submit" disabled={loading} className="l-btn">
                {loading
                  ? <><Spinner />Вход...</>
                  : <>Войти <span style={{ fontSize: 16 }}>→</span></>
                }
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── Helpers ── */

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px 10px 38px', fontSize: 14,
  border: '1px solid #d0d5dd', borderRadius: 8, outline: 'none',
  color: '#101828', background: '#fff', boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

function IconWrap({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)',
      color: '#98a2b3', pointerEvents: 'none', lineHeight: 0 }}>
      {children}
    </span>
  )
}

function FeatureRow({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div>
        <div style={{ color: '#fff', fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 1 }}>{desc}</div>
      </div>
    </div>
  )
}

function Spinner() {
  return <span style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
    border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', display: 'inline-block',
    animation: 'spin 0.7s linear infinite' }} />
}

function MailIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
  </svg>
}
function LockIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
}
function EyeIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
  </svg>
}
function EyeOffIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>
  </svg>
}
