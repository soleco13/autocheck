interface AppLogoProps {
  size?: number
}

export function AppLogo({ size = 36 }: AppLogoProps) {
  return (
    <img
      src="/logo.png"
      alt="AutoCheck"
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  )
}

export function AppLogoFull({ collapsed }: { collapsed: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
      <AppLogo size={36} />
      {!collapsed && (
        <span style={{
          fontWeight: 700,
          fontSize: 16,
          color: 'var(--c-text)',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.2px',
        }}>
          AutoCheck
        </span>
      )}
    </div>
  )
}
