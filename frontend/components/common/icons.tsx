import type React from "react";

// 统一的线性图标：16px 视框、1.5px 线宽，颜色跟随文字。只在表达含义时使用。
function Svg({
  children,
  size = 16,
  className = "",
}: {
  children: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ChevronDown = (props: { className?: string }) => (
  <Svg {...props}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Svg>
);
export const ChevronRight = (props: { className?: string }) => (
  <Svg {...props}>
    <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />
  </Svg>
);
export const ArrowLeft = (props: { className?: string }) => (
  <Svg {...props}>
    <path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5" />
  </Svg>
);
export const Check = (props: { className?: string }) => (
  <Svg {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
export const Close = (props: { className?: string }) => (
  <Svg {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const More = (props: { className?: string }) => (
  <Svg {...props}>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Svg>
);
export const External = (props: { className?: string }) => (
  <Svg {...props} size={12}>
    <path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7.5 8.5" />
  </Svg>
);
export const Search = (props: { className?: string }) => (
  <Svg {...props}>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3 3" />
  </Svg>
);

// 状态图形：形状表达阶段，颜色由外层 CSS 决定（只有要人处理的状态上色）。
export type StatusShape = "queued" | "running" | "done" | "attention" | "failed" | "alert" | "stopped";
export function StatusGlyph({ shape }: { shape: StatusShape }) {
  return (
    <Svg className={`status-glyph glyph-${shape}`} size={14}>
      {shape === "queued" && <circle cx="8" cy="8" r="5.5" />}
      {shape === "running" && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
        </>
      )}
      {shape === "done" && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m5.6 8.2 1.7 1.7 3.1-3.6" />
        </>
      )}
      {shape === "attention" && <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 1.9" />}
      {shape === "failed" && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m6 6 4 4M10 6l-4 4" />
        </>
      )}
      {shape === "alert" && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.2v3.3" />
          <circle cx="8" cy="10.8" r="0.5" fill="currentColor" />
        </>
      )}
      {shape === "stopped" && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m4.2 11.8 7.6-7.6" />
        </>
      )}
    </Svg>
  );
}
