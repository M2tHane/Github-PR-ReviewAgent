import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, messageOf, setCsrf } from "./api/client.js";
import { AppLayout, type Section } from "./components/layout/app-layout.js";
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
import { ServiceSettingsPage } from "./pages/service-settings-page.js";
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
  const section: Section = rules
    ? "rules"
    : reviews
      ? "reviews"
      : repositories
        ? "repositories"
        : health
          ? "health"
          : runs
            ? "runs"
            : discussions
              ? "discussions"
              : route === "settings/service"
                ? "service"
                : settings
                  ? "settings"
                  : "overview";
  const pendingRules = memories.filter((item) => item.status === "CANDIDATE").length;
  const updateRepository = (value: Repo) =>
    setRepos((items) => items.map((item) => (item.id === value.id ? value : item)));
  if (!session)
    return (
      <main className="login">
        <div className="login-theme">
          <ThemeSwitch />
        </div>
        <div className="login-card">
          <h1>Pi Review</h1>
          <p>用 GitHub 账号登录，查看 PR 审查和仓库规则。</p>
          {initializing ? (
            <p role="status">正在加载…</p>
          ) : (
            <>
              {error && <p className="error">{error}</p>}
              <a className="button primary" href="/auth/github">
                使用 GitHub 登录
              </a>
            </>
          )}
        </div>
      </main>
    );
  return (
    <AppLayout
      section={section}
      pendingRules={pendingRules}
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
        <p className="muted" role="status">
          正在加载管理数据…
        </p>
      ) : (
        <>
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
              <Empty action={<a href="#repositories">返回仓库列表</a>}>
                找不到这个仓库，或当前账号没有它的管理权限。
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
          ) : route === "settings/service" ? (
            <ServiceSettingsPage onRepositoriesChange={load} />
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
