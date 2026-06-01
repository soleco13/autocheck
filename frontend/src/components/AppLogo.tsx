interface AppLogoProps {
  size?: number
}

export function AppLogo({ size = 30 }: AppLogoProps) {
  return (
    <img
      src="/logo.png"
      alt="AutoCheck"
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block', flexShrink: 0 }}
    />
  )
}

export function AppLogoFull({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      <AppLogo size={30} />
      <span className="wordmark">Auto<b>Check</b></span>
    </>
  )
}
