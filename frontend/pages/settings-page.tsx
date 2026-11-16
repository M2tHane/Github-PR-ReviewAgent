import { ChevronRight } from "../components/common/icons.js";

export function SettingsPage() {
  return (
    <section>
      <div className="page-head">
        <h2>设置</h2>
        <p className="muted">调整审查方式，查看仓库健康与系统运行情况。</p>
      </div>
      <div className="list settings-list">
        {[
          ["repositories", "仓库设置", "审查范围、输出语言、资源上限、定时健康检查与群内开发，按仓库设置"],
          ["settings/service", "服务设置", "时限、定时任务、数据保留、模型和并发，对所有仓库生效"],
          ["settings/health", "仓库健康检查", "手动检查与历史结论"],
          ["settings/runs", "系统运行记录", "失败原因、发布核对与执行信息"],
          ["settings/discussions", "审查讨论", "问题回复、复核结论与后续线索"],
        ].map(([key, title, description]) => (
          <a className="list-row" href={`#${key}`} key={key}>
            <span className="row-title">{title}</span>
            <span className="row-meta settings-description">{description}</span>
            <ChevronRight className="row-chevron" />
          </a>
        ))}
      </div>
    </section>
  );
}
