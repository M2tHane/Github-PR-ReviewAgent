import { useJobPage } from "../api/jobs.js";
import { Pager } from "../components/common/pager.js";
import { ReviewRow, SeverityLegend } from "../features/reviews/review-row.js";
import type { Repository as Repo } from "../types.js";

const PAGE_SIZE = 20;
// 状态分组：页面上只给几个大类，对应的任务状态交给接口筛选。
const STATUS_GROUPS: Array<[key: string, label: string, statuses: string]> = [
  ["done", "已完成", "succeeded,partial"],
  ["active", "进行中", "queued,running"],
  ["attention", "失败或待核对", "failed,timeout,uncertain"],
  ["stopped", "已取消或过期", "cancelled,superseded"],
];

// 筛选条件和页码放在地址里（#reviews?repo=1&status=done&page=2），从详情返回时还在原来的位置。
export function ReviewsPage({ repositories, search }: { repositories: Repo[]; search: string }) {
  const query = new URLSearchParams(search);
  const repo = repositories.some((item) => String(item.id) === query.get("repo")) ? query.get("repo")! : "",
    group = STATUS_GROUPS.find(([key]) => key === query.get("status")),
    page = Math.max(1, Math.floor(Number(query.get("page"))) || 1);
  const { data, loading, error } = useJobPage({
    type: "PR_REVIEW",
    repositoryId: repo,
    status: group?.[2],
    page,
    pageSize: PAGE_SIZE,
  });
  const go = (next: { repo?: string; status?: string; page?: number }) => {
    const value = { repo, status: group?.[0] ?? "", page: 1, ...next };
    const params = new URLSearchParams();
    if (value.repo) params.set("repo", value.repo);
    if (value.status) params.set("status", value.status);
    if (value.page > 1) params.set("page", String(value.page));
    location.hash = params.size ? `reviews?${params}` : "reviews";
  };
  const filtered = Boolean(repo || group);
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>PR 审查</h2>
          <p className="muted">每次审查一条记录；同一个 PR 推送新提交后会有多条。</p>
        </div>
        <SeverityLegend />
      </div>
      <div className="list-filters">
        <label>
          仓库
          <select value={repo} onChange={(event) => go({ repo: event.target.value })}>
            <option value="">所有仓库</option>
            {repositories.map((item) => (
              <option value={item.id} key={item.id}>
                {item.fullName}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={group?.[0] ?? ""} onChange={(event) => go({ status: event.target.value })}>
            <option value="">全部状态</option>
            {STATUS_GROUPS.map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && (
          <p className="empty-line" role="status">
            正在加载…
          </p>
        )
      ) : !data.items.length ? (
        <p className="empty-line">
          {data.total > 0 ? (
            <>
              这一页没有记录。<a href="#reviews">回到第一页</a>
            </>
          ) : filtered ? (
            "没有符合筛选条件的审查。"
          ) : (
            "还没有审查记录。接入的仓库有新 PR 时会出现在这里。"
          )}
        </p>
      ) : (
        <div className="review-list" aria-busy={loading}>
          {data.items.map((job) => (
            <ReviewRow job={job} key={job.id} showSha />
          ))}
        </div>
      )}
      {data && (
        <Pager
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          disabled={loading}
          onPage={(value) => go({ page: value })}
        />
      )}
    </section>
  );
}
