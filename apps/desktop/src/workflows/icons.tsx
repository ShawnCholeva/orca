// Minimal inline SVG icons used by workflow DAG components.
// Paths lifted verbatim from the design prototype's ui.jsx Icon set.

interface IconProps {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}

function ic(path: React.ReactNode, vb = "0 0 24 24") {
  return function IconComponent({ size = 16, color = "currentColor", style }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={vb}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
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

export const PlusIcon = ic(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

export const CloseIcon = ic(
  <>
    <path d="M6 6l12 12" />
    <path d="M18 6l-12 12" />
  </>,
);

export const ArrowRightIcon = ic(
  <>
    <path d="M5 12h14" />
    <path d="M13 5l7 7-7 7" />
  </>,
);

export const ChevronLeftIcon = ic(<path d="M15 6l-6 6 6 6" />);

export const ChevronRightIcon = ic(<path d="M9 6l6 6-6 6" />);

export const CheckIcon = ic(<path d="M5 12l4.5 4.5L19 7" />);

export const DragIcon = ic(
  <>
    <circle cx="9" cy="6" r="0.8" fill="currentColor" />
    <circle cx="9" cy="12" r="0.8" fill="currentColor" />
    <circle cx="9" cy="18" r="0.8" fill="currentColor" />
    <circle cx="15" cy="6" r="0.8" fill="currentColor" />
    <circle cx="15" cy="12" r="0.8" fill="currentColor" />
    <circle cx="15" cy="18" r="0.8" fill="currentColor" />
  </>,
);

/** Diamond shape used for gate nodes. */
export function GateGlyph({ size = 14 }: { size?: number }) {
  return (
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
    >
      <path d="M12 3l9 9-9 9-9-9 9-9z" />
    </svg>
  );
}
