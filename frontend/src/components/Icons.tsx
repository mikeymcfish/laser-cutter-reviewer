import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const Svg = ({ size = 20, children, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
)

export const UploadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
    <path d="M5 13.5v4.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V13.5" />
  </Svg>
)

export const FileIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 3h6l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M13 3v5h5M8.5 13h7M8.5 17h5" />
  </Svg>
)

export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 12 4.2 4.2L19 6.5" />
  </Svg>
)

export const XIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m7 7 10 10M17 7 7 17" />
  </Svg>
)

export const WarningIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.4 4.2 2.8 17.4A1.8 1.8 0 0 0 4.35 20h15.3a1.8 1.8 0 0 0 1.55-2.6L13.6 4.2a1.85 1.85 0 0 0-3.2 0Z" />
    <path d="M12 9v4.5M12 17h.01" />
  </Svg>
)

export const InfoIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
)

export const EyeIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
)

export const DownloadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" />
  </Svg>
)

export const ResetIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.5 9A8 8 0 1 1 4 14" />
    <path d="M4.5 4v5h5" />
  </Svg>
)

export const SparkIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m12 3 .9 3.1a6.7 6.7 0 0 0 4.5 4.5l3.1.9-3.1.9a6.7 6.7 0 0 0-4.5 4.5L12 20l-.9-3.1a6.7 6.7 0 0 0-4.5-4.5l-3.1-.9 3.1-.9a6.7 6.7 0 0 0 4.5-4.5L12 3Z" />
  </Svg>
)

export const CubeIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4.4 7.7 7.6 4.4 7.6-4.4M12 12.1V21" />
  </Svg>
)
