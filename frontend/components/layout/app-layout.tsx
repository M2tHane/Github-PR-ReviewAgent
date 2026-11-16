import type React from "react";
import { ThemeSwitch } from "../common/theme-switch.js";

export type Section = "overview" | "reviews" | "rules" | "repositories" | "service" | "health" | "runs" | "discussions";

const primary: Array<[key: Section, label: string, href: string]> = [
  ["overview", "概览", "#overview"],
  ["reviews", "PR 审查", "#reviews"],
  ["rules", "规则", "#rules"],
  ["repositories", "仓库", "#repositories"],
];
const settings: Array<[key: Section, label: string, href: string]> = [
  ["service", "服务设置", "#settings/service"],
  ["health", "健康检查", "#settings/health"],
  ["runs", "运行记录", "#settings/runs"],
  ["discussions", "审查讨论", "#settings/discussions"],
];

// 左侧栏导航：主要页面平铺，设置子页归在不可点击的“设置”分组下，当前位置用底色标出；规则旁显示待确认数。
export function AppLayout({
  section,
  pendingRules,
  login,
  mainRef,
  onLogout,
  children,
}: {
  section: Section;
  pendingRules: number;
  login: string;
  mainRef: React.RefObject<HTMLElement | null>;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const item = ([key, label, href]: [Section, string, string]) => (
    <a
      className={section === key ? "active" : undefined}
      aria-current={section === key ? "page" : undefined}
      href={href}
      key={key}
    >
      <span>{label}</span>
      {key === "rules" && pendingRules > 0 && (
        <span className="nav-count" title={`${pendingRules} 条规则待确认`}>
          {pendingRules}
          <span className="sr-only"> 条待确认</span>
        </span>
      )}
    </a>
  );
  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="#overview">
          <span className="brand-mark" aria-hidden="true">
            π
          </span>
          Pi Review
        </a>
        <nav className="nav" aria-label="主导航">
          {primary.map(item)}
          {/* 设置只是分组标题，不是页面。 */}
          <div className="nav-group" id="nav-settings">
            设置
          </div>
          <div role="group" aria-labelledby="nav-settings" className="nav-sub">
            {settings.map(item)}
          </div>
        </nav>
        <div className="sidebar-foot">
          <ThemeSwitch />
          <div className="account">
            <span title={login}>{login}</span>
            <button type="button" className="ghost compact" onClick={onLogout}>
              退出
            </button>
          </div>
        </div>
      </aside>
      <main ref={mainRef} id="main-content" tabIndex={-1} className="shell">
        {children}
      </main>
    </div>
  );
}
