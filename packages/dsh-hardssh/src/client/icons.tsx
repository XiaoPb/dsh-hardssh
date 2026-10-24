/**
 * Workspace icons for the SSH workspace surfaces: a cloud with a return arrow
 * (SSH/remote workspace) and a desktop monitor (local workspace). Inlined SVG
 * (1024 viewBox, solid fill) — no icon library dependency. Both inherit the
 * theme text color via `currentColor` so they stay legible in light/dark
 * themes.
 *
 * The local directory browser uses a second, line-based family (24 viewBox,
 * 1.7 stroke) that mirrors the dsh picker's own icon language: folder, home,
 * app data, documents, storage, download, plus/check/chevron controls. They
 * are decorative (`aria-hidden`), inherit `currentColor`, and stay crisp at
 * 10–16px.
 * @module dsh-hardssh/client/icons
 */

import type { ReactElement, ReactNode } from 'react'
import type { LocalRootKind } from '../protocol.ts'

interface IconProps {
  size?: number
  className?: string
}

/** Desktop-monitor icon: a local workstation (monitor + stand). */
export function ComputerIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M873.6 788.48H150.4a91.52 91.52 0 0 1-92.16-91.52V256a91.52 91.52 0 0 1 92.16-90.88h723.2A91.52 91.52 0 0 1 965.76 256v440.32a91.52 91.52 0 0 1-92.16 92.16zM150.4 229.12a28.16 28.16 0 0 0-28.16 26.88v440.32a28.16 28.16 0 0 0 28.16 27.52h723.2a27.52 27.52 0 0 0 28.16-27.52V256a27.52 27.52 0 0 0-28.16-27.52z" />
      <path d="M99.84 593.28h833.92v64H99.84zM762.24 931.84H261.12a32 32 0 0 1 0-64h501.12a32 32 0 0 1 32 32 32 32 0 0 1-32 32z" />
      <path d="M383.36 771.2h64v110.08h-64zM588.16 771.2h64v110.08h-64z" />
    </svg>
  )
}

/** Cloud-with-return-arrow icon: a remote/SSH workspace. */
export function CloudIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M743.936 758.499556h-273.066667c-17.066667 0-34.133333-17.066667-34.133333-34.133334s17.066667-34.133333 34.133333-34.133333h273.066667c28.444444 0 153.6-5.688889 153.6-130.844445 0-142.222222-153.6-164.977778-159.288889-164.977777-17.066667 0-28.444444-11.377778-28.444444-22.755556-22.755556-85.333333-108.088889-142.222222-193.422223-130.844444-136.533333 0-176.355556 79.644444-199.111111 164.977777-5.688889 5.688889-22.755556 17.066667-39.822222 17.066667 0 0-153.6 5.688889-153.6 142.222222 0 119.466667 130.844444 125.155556 153.6 125.155556 17.066667 0 34.133333 17.066667 34.133333 34.133333s-17.066667 34.133333-34.133333 34.133334c-113.777778 0-227.555556-62.577778-227.555555-193.422223 0-142.222222 119.466667-204.8 199.111111-210.488889 22.755556-68.266667 79.644444-193.422222 261.688889-193.422222 113.777778-11.377778 216.177778 56.888889 256 164.977778 79.644444 17.066667 199.111111 79.644444 199.111111 233.244444 5.688889 136.533333-108.088889 199.111111-221.866667 199.111112z" />
      <path d="M573.269333 866.588444c-11.377778 0-17.066667-5.688889-22.755555-11.377777l-108.088889-108.088889c-5.688889-5.688889-11.377778-17.066667-11.377778-22.755556s5.688889-17.066667 11.377778-22.755555l108.088889-108.088889c11.377778-11.377778 34.133333-11.377778 51.2 0 11.377778 11.377778 11.377778 34.133333 0 51.2l-79.644445 79.644444 79.644445 79.644445c11.377778 11.377778 11.377778 34.133333 0 51.2-5.688889 5.688889-17.066667 11.377778-28.444445 11.377777z" />
    </svg>
  )
}

/* ---------------------------------------------------------------------------
 * Line icons for the local directory browser (24 viewBox, 1.7 stroke).
 * ------------------------------------------------------------------------- */

interface LineIconProps extends IconProps {
  children: ReactNode
}

/** Shared line-icon frame: inherits the text color and never announces itself. */
function LineIcon({ size = 14, className, children }: LineIconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  )
}

/** Folder (closed) — directory rows and the local-browser title. */
export function FolderIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </LineIcon>
  )
}

/** Folder with a plus — the "new folder" action. */
export function FolderPlusIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M12 11v6M9 14h6" />
    </LineIcon>
  )
}

/** House — the home quick-jump root. */
export function HomeIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M3.5 10.6 12 3.5l8.5 7.1V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1Z" />
    </LineIcon>
  )
}

/** Box — the app-data quick-jump root. */
export function AppDataIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M12 3 20.5 7.5v9L12 21 3.5 16.5v-9Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5" />
      <path d="M12 12v9" />
    </LineIcon>
  )
}

/** Document — the Documents quick-jump root. */
export function DocumentIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5Z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9 12.5h6" />
      <path d="M9 16h4" />
    </LineIcon>
  )
}

/** Phone — internal storage. */
export function StorageIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M8.5 2.5h7A1.5 1.5 0 0 1 17 4v16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20V4a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M10.5 18.5h3" />
    </LineIcon>
  )
}

/** Download arrow — the Downloads quick-jump root. */
export function DownloadIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M12 3.5v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4.5 20.5h15" />
    </LineIcon>
  )
}

/** Chevron pointing up — "up one level". */
export function ChevronUpIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M5.5 14.5 12 8l6.5 6.5" />
    </LineIcon>
  )
}

/** Chevron pointing right — breadcrumb separator / row affordance. */
export function ChevronRightIcon({ size = 12, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </LineIcon>
  )
}

/** Arrow pointing right — "open the typed path". */
export function ArrowRightIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M4.5 12h14" />
      <path d="M12.5 6 18.5 12l-6 6" />
    </LineIcon>
  )
}

/** Check mark — the primary "use this directory" action. */
export function CheckIcon({ size = 14, className }: IconProps): ReactElement {
  return (
    <LineIcon size={size} className={className}>
      <path d="M5 12.5 9.5 17 19 7.5" />
    </LineIcon>
  )
}

/** Icon for one quick-jump root kind (home / app data / documents / storage / downloads). */
export function LocalRootIcon({ kind, size = 13, className }: IconProps & { kind: LocalRootKind }): ReactElement {
  switch (kind) {
    case 'home': return <HomeIcon size={size} className={className} />
    case 'app-data': return <AppDataIcon size={size} className={className} />
    case 'documents': return <DocumentIcon size={size} className={className} />
    case 'storage': return <StorageIcon size={size} className={className} />
    case 'downloads': return <DownloadIcon size={size} className={className} />
    default: return <FolderIcon size={size} className={className} />
  }
}