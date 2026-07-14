// Inline SVG icons used by the Workspaces tab.
// Paths lifted verbatim from the design prototype's ui.jsx Icon set, in the
// same `ic()` style the app already uses for workflow icons.

interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

function ic(path: React.ReactNode, vb = "0 0 24 24") {
  return function IconComponent({
    size = 16,
    color = "currentColor",
    strokeWidth = 1.5,
    style,
  }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={vb}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };
}

export const Icon = {
  plus: ic(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
  ),
  close: ic(
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </>,
  ),
  settings: ic(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  ),
  goal: ic(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>,
  ),
  pause: ic(
    <>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </>,
  ),
  check: ic(<path d="M5 12l4.5 4.5L19 7" />),
  arrowRight: ic(
    <>
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </>,
  ),
  folder: ic(
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  ),
  workspace: ic(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>,
  ),
  chevronDown: ic(<path d="M6 9l6 6 6-6" />),
  chevronLeft: ic(<path d="M15 6l-6 6 6 6" />),
  sparkle: ic(
    <>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="M5.5 5.5l2.8 2.8" />
      <path d="M15.7 15.7l2.8 2.8" />
      <path d="M5.5 18.5l2.8-2.8" />
      <path d="M15.7 8.3l2.8-2.8" />
    </>,
  ),
  cpu: ic(
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 9h6v6H9z" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>,
  ),
  workflow: ic(
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <path d="M6 9v3h12V9" />
      <path d="M12 12v3" />
    </>,
  ),
};
