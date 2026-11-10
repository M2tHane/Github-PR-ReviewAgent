import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, messageOf, setCsrf } from "./api/client.js";
import { AppLayout } from "./components/layout/app-layout.js";
import { Empty } from "./components/common/empty-state.js";
import { ThemeSwitch } from "./components/common/theme-switch.js";
import { HealthPanel } from "./features/health/health-panel.js";
import { DiscussionPage } from "./features/reviews/discussions.js";
import { ReviewDetails } from "./features/reviews/review-detail.js";
import { JobsPage } from "./pages/jobs-page.js";
import { MemoriesPage } from "./pages/memories-page.js";
import { OverviewPage } from "./pages/overview-page.js";
import { ReviewsPage } from "./pages/reviews-page.js";
import { RepositoryPage } from "./pages/repository-page.js";
import { RepositorySettingsPage, type RepositoryTab } from "./pages/repository-settings-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import type { BootstrapResponse, Memory, Repository as Repo, SessionResponse } from "./types.js";

// 审查策略已并入各仓库的设置页，旧链接落到仓库列表。
function currentRoute() {
  if (location.hash === "#settings/policy") history.replaceState(null, "", "#repositories");
  return location.hash.slice(1) || "overview";
}

function App() {
  const [session, setSession] = useState<any>(null),
    [initializing, setInitializing] = useState(true),
    [route, setRoute] = useState(currentRoute);
  const [repos, setRepos] = useState<Repo[]>([]),
    [memories, setMemories] = useState<Memory[]>([]),
    [error, setError] = useState("");
  const main = useRef<HTMLElement>(null),
    previousRoute = useRef(route);
  async function load() {
    try {
      const value = await api<SessionResponse>("/api/session");
      setCsrf(value.csrf);
      setSession(value.user);
      const data = await api<BootstrapResponse>("/api/bootstrap");
      setRepos(data.repositories);
      setMemories(data.memories);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
      throw cause;
    } finally {
      setInitializing(false);
    }
  }
  useEffect(() => {
    void load().catch(() => {});
    const changed = () => setRoute(currentRoute());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const fromRules = previousRoute.current.startsWith("rules");
    previousRoute.current = route;
    if (!route.startsWith("rules") || route.endsWith("/edit") || !fromRules) {
      main.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }, [route]);
  const rules = route.startsWith("rules") || route === "memories",
    health = route.startsWith("health") || route.startsWith("settings/health"),
    runs = route === "settings/runs" || route === "jobs",
    discussions = route === "settings/discussions" || route === "discussions",
    settings = route.startsWith("settings") || health || runs || discussions;
  // 审查列表的筛选和页码跟在路由后面：reviews?repo=1&page=2。
  const [path, search = ""] = route.split("?");
  const review = route.match(/^reviews\/([0-9a-f-]{36})$/i),
    reviews = path === "reviews" || Boolean(review);
  const repositoryRoute = route.match(/^repositories\/(\d+)(?:\/(health|development|tasks))?$/),
    repositories = route === "repositories" || Boolean(repositoryRoute),
    repository = repositoryRoute && repos.find((item) => item.id === Number(repositoryRoute[1]));
  const updateRepository = (value: Repo) =>
    setRepos((items) => items.map((item) => (item.id === value.id ? value : item)));
  if (!session)
    return (
      <main className="login">
        <div className="login-theme">
          <ThemeSwitch />
        </div>
        <div className="login-card">
          <p className="eyebrow">Pi · 代码审查与团队规则</p>
          <h1>把团队决定，带进下一次 Review。</h1>
          <p>找到需要处理的问题，记住已经确认的工程约定。</p>
          {initializing ? (
            <p role="status">正在加载…</p>
          ) : (
            <>
              {error && <p className="error">{error}</p>}
              <a className="button" href="/auth/github">
                使用 GitHub 登录 →
              </a>
            </>
          )}
        </div>
      </main>
    );
  return (
    <AppLayout
      navigation={{
        overview: !reviews && !rules && !repositories && !settings,
        reviews,
        rules,
        repositories,
        settings,
      }}
      login={session.login}
      mainRef={main}
      onLogout={() =>
        void api("/auth/logout", { method: "POST", body: "{}" })
          .then(() => location.reload())
          .catch((cause) => setError(messageOf(cause)))
      }
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {initializing ? (
        <p role="status">正在加载管理数据…</p>
      ) : (
        <>
          {settings && route !== "settings" && (
            <a className="back-link" href="#settings">
              ← 设置
            </a>
          )}
          {rules ? (
            <MemoriesPage
              items={memories}
              repositories={repos}
              reload={load}
              route={route === "memories" ? "rules" : route}
            />
          ) : repositoryRoute ? (
            repository ? (
              <RepositorySettingsPage
                key={repository.id}
                repo={repository}
                tab={(repositoryRoute[2] as RepositoryTab | undefined) ?? "review"}
                onRepositoryUpdated={updateRepository}
              />
            ) : (
              <Empty>
                找不到这个仓库，或当前账号没有它的管理权限。<a href="#repositories">返回仓库列表</a>
              </Empty>
            )
          ) : route === "repositories" ? (
            <RepositoryPage items={repos} />
          ) : runs ? (
            <JobsPage />
          ) : health ? (
            <HealthPanel repositories={repos} />
          ) : discussions ? (
            <DiscussionPage repositories={repos} />
          ) : route === "settings" ? (
            <SettingsPage />
          ) : review ? (
            <ReviewDetails id={review[1]!} />
          ) : path === "reviews" ? (
            <ReviewsPage repositories={repos} search={search} />
          ) : (
            <OverviewPage repositories={repos} memories={memories} login={session.login} />
          )}
        </>
      )}
    </AppLayout>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
