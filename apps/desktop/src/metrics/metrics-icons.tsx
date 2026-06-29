import type { CSSProperties, ReactElement, ReactNode } from "react";

interface IconProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

function svg(path: ReactNode) {
  return function IconCmp({ size = 16, color = "currentColor", style }: IconProps): ReactElement {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
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

export const ChevronRight = svg(<path d="M9 6l6 6-6 6" />);
export const ChevronDown = svg(<path d="M6 9l6 6 6-6" />);
export const ChevronLeft = svg(<path d="M15 6l-6 6 6 6" />);
export const Check = svg(<path d="M5 12l4.5 4.5L19 7" />);
export const Close = svg(<><path d="M6 6l12 12" /><path d="M18 6l-12 12" /></>);
export const Sparkle = svg(
  <><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /><path d="M5.5 5.5l2.8 2.8" /><path d="M15.7 15.7l2.8 2.8" /><path d="M5.5 18.5l2.8-2.8" /><path d="M15.7 8.3l2.8-2.8" /></>
);
export const Spark = svg(<path d="M3 17l5-6 4 3 4-7 5 5" />);
export const Workflow = svg(
  <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><path d="M6 9v3h12V9" /><path d="M12 12v3" /></>
);
