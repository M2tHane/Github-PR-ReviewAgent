import { useLayoutEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const storageKey = "pi-review-theme";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch (error) {
    // 浏览器禁用站点存储时仍允许本次页面切换主题。
    console.warn("无法读取主题偏好，将跟随系统。", error);
    return "system";
  }
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <>
      <select
        className="theme-switch"
        aria-label="主题"
        title="切换页面主题"
        value={theme}
        onChange={(event) => {
          const value = event.target.value as Theme;
          setTheme(value);
          setError("");
          try {
            localStorage.setItem(storageKey, value);
          } catch {
            setError("浏览器不允许保存偏好，本次主题已切换，刷新后无法保留。");
          }
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      {error && <span role="status">{error}</span>}
    </>
  );
}
