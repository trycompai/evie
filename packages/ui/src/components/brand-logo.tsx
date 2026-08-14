import { cn } from "@evie/ui/lib/utils"

/**
 * Third-party brand marks, reproduced here for identification in the
 * connection catalog only. Each is copied verbatim from the vendor's
 * published mark -- original viewBox, original path data, original fills --
 * never converted to `currentColor` and never recoloured to fit Evie's
 * palette. A Slack logo tinted to match a theme is not the Slack logo, it's
 * a shape that used to be one, so every mark keeps its own colours in both
 * light and dark mode.
 *
 * Order below follows the two Paper artboards this was extracted from: the
 * Plugins modal's eight rows, then the onboarding grid's remaining seven.
 */

export type BrandId =
  | "gmail"
  | "google-calendar"
  | "google-drive"
  | "notion"
  | "slack"
  | "linear"
  | "hubspot"
  | "github"
  | "google-workspace"
  | "salesforce"
  | "microsoft-365"
  | "linkedin"
  | "zoom"
  | "jira"
  | "stripe"

export interface BrandLogoProps {
  readonly brand: BrandId
  /** Rendered size in px, applied to both dimensions of the `<svg>`. Matches the Plugins list's 23px icon. */
  readonly size?: number
  readonly className?: string
}

/**
 * Marks that are pure black or pure white vanish against a matching-tone
 * theme background when rendered bare, outside `BrandTile`'s white plate.
 * Notion's mark is a literal `#000`, and GitHub's is `#181717` -- near-black
 * and, against a dark surface, effectively invisible -- so the design never
 * places either without a plate behind it. Named here rather than branched
 * at the call site.
 */
export const BRAND_NEEDS_PLATE: Record<BrandId, boolean> = {
  gmail: false,
  "google-calendar": false,
  "google-drive": false,
  notion: true,
  slack: false,
  linear: false,
  hubspot: false,
  github: true,
  "google-workspace": false,
  salesforce: false,
  "microsoft-365": false,
  linkedin: false,
  zoom: false,
  jira: false,
  stripe: false,
}

interface BrandMark {
  readonly viewBox: string
  readonly content: React.ReactNode
}

const MARKS: Record<BrandId, BrandMark> = {
  gmail: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
        fill="#EA4335"
      />
    ),
  },
  "google-calendar": {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"
        fill="#4285F4"
      />
    ),
  },
  "google-drive": {
    viewBox: "0 0 87.3 78",
    content: (
      <>
        <path
          d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z"
          fill="#0066DA"
        />
        <path
          d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 0 0 0 53h27.5z"
          fill="#00AC47"
        />
        <path
          d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z"
          fill="#EA4335"
        />
        <path
          d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z"
          fill="#00832D"
        />
        <path
          d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
          fill="#2684FC"
        />
        <path
          d="M73.4 26.5 60.7 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
          fill="#FFBA00"
        />
      </>
    ),
  },
  notion: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
        fill="#000000"
      />
    ),
  },
  slack: {
    viewBox: "0 0 122.8 122.8",
    content: (
      <>
        <path
          d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
          fill="#E01E5A"
        />
        <path
          d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
          fill="#36C5F0"
        />
        <path
          d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
          fill="#2EB67D"
        />
        <path
          d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
          fill="#ECB22E"
        />
      </>
    ),
  },
  linear: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
        fill="#5E6AD2"
      />
    ),
  },
  hubspot: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z"
        fill="#FF7A59"
      />
    ),
  },
  github: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="#181717"
      />
    ),
  },
  "google-workspace": {
    viewBox: "0 0 48 48",
    content: (
      <>
        <path
          d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
          fill="#4285F4"
        />
        <path
          d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
          fill="#34A853"
        />
        <path
          d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
          fill="#FBBC05"
        />
        <path
          d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
          fill="#EA4335"
        />
      </>
    ),
  },
  salesforce: {
    viewBox: "0 0 24 17",
    content: (
      <path
        d="M9.87 2.03A4.33 4.33 0 0 1 13.02.7c1.63 0 3.05.91 3.81 2.26a5.27 5.27 0 0 1 2.15-.46A5.36 5.36 0 0 1 24 7.9a5.36 5.36 0 0 1-5.02 5.4l-.36.01c-.4 0-.78-.04-1.15-.12a3.9 3.9 0 0 1-3.42 2.03c-.55 0-1.07-.13-1.53-.35a4.46 4.46 0 0 1-4.14 2.8 4.46 4.46 0 0 1-4.2-2.98 4.1 4.1 0 0 1-.86.09A4.28 4.28 0 0 1 0 10.5c0-1.58.84-2.96 2.09-3.7a4.9 4.9 0 0 1-.41-1.96 4.94 4.94 0 0 1 8.19-3.7"
        fill="#00A1E0"
      />
    ),
  },
  "microsoft-365": {
    viewBox: "0 0 23 23",
    content: (
      <>
        <rect x="0" y="0" width="10.5" height="10.5" fill="#F25022" />
        <rect x="12.5" y="0" width="10.5" height="10.5" fill="#7FBA00" />
        <rect x="0" y="12.5" width="10.5" height="10.5" fill="#00A4EF" />
        <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
      </>
    ),
  },
  linkedin: {
    viewBox: "0 0 24 24",
    content: (
      <>
        <rect width="24" height="24" rx="3.2" fill="#0A66C2" />
        <path
          d="M7.12 9.6H4.63V19h2.49V9.6zM5.87 8.5a1.45 1.45 0 1 0 0-2.9 1.45 1.45 0 0 0 0 2.9zM19.4 19h-2.49v-4.86c0-1.16-.42-1.95-1.46-1.95-.8 0-1.27.54-1.48 1.05-.08.19-.1.44-.1.7V19h-2.49s.03-7.79 0-8.6v-.8h2.49v1.33c.33-.51.92-1.24 2.24-1.24 1.63 0 2.86 1.07 2.86 3.36V19z"
          fill="#FFFFFF"
        />
      </>
    ),
  },
  zoom: {
    viewBox: "0 0 24 24",
    content: (
      <>
        <circle cx="12" cy="12" r="12" fill="#0B5CFF" />
        <path
          d="M5.6 9.4c0-.55.45-1 1-1h6.1c.55 0 1 .45 1 1v5.2c0 .55-.45 1-1 1H6.6c-.55 0-1-.45-1-1V9.4zM14.6 11.1l3.2-2.2c.35-.24.8.01.8.44v5.32c0 .43-.45.68-.8.44l-3.2-2.2v-1.8z"
          fill="#FFFFFF"
        />
      </>
    ),
  },
  jira: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"
        fill="#2684FF"
      />
    ),
  },
  stripe: {
    viewBox: "0 0 24 24",
    content: (
      <path
        d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"
        fill="#635BFF"
      />
    ),
  },
}

/** A brand's mark at its own colours. The row's text names the service, so the mark stays decorative. */
export function BrandLogo({ brand, size = 23, className }: BrandLogoProps) {
  const mark = MARKS[brand]
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      {mark.content}
    </svg>
  )
}

export interface BrandTileProps {
  readonly brand: BrandId
  /** Rendered tile size in px. Defaults to the Plugins list's 40px tile. */
  readonly size?: number
  readonly className?: string
}

/**
 * The white plate every plugin row and the onboarding grid set a logo on.
 * The design keeps this plate pure white in both themes -- the onboarding
 * grid's cards are dark-surface, yet its logo tiles are still `#FFFFFF` --
 * because it's what keeps a colourful mark like Slack's evenly lit and a
 * monochrome one like GitHub's or Notion's visible at all (see
 * `BRAND_NEEDS_PLATE`). Radius and icon size both scale off the tile's own
 * size, so a 34px onboarding tile and this package's default 40px tile are
 * the same drawing at two scales rather than two drawings that drift.
 */
export function BrandTile({ brand, size = 40, className }: BrandTileProps) {
  const radius = Math.round(size * 0.25)
  const iconSize = Math.round(size * 0.575)
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: "#FFFFFF" }}
    >
      <BrandLogo brand={brand} size={iconSize} />
    </div>
  )
}
