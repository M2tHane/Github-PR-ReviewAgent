export function SettingsPage() {
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>设置</h2>
          <p className="muted">调整审查方式，查看仓库健康与系统运行情况。</p>
        </div>
      </div>
      <div className="settings-list">
        {[
          ["repositories", "仓库设置", "审查范围、输出语言、资源上限、定时健康检查与群内开发，按仓库设置"],
          ["settings/health", "仓库健康检查", "手动检查与历史结论"],
          ["settings/runs", "系统运行记录", "失败原因、发布核对与执行信息"],
          ["settings/discussions", "审查讨论", "问题回复、复核结论与后续线索"],
        ].map(([key, title, description]) => (
          <a href={`#${key}`} key={key}>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
            <span aria-hidden="true">→</span>
          </a>
        ))}
      </div>
    </section>
  );
}
