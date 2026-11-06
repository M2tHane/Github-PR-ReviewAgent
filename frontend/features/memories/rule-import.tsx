import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Modal } from "../../components/common/modal.js";
import type { Memory, Repository } from "../../types.js";
import { memorySourceLabel } from "../../../src/memory/types.js";
import {
  RULE_IMPORT_EXAMPLE,
  MAX_MARKDOWN_BYTES,
  IMPORT_TYPES,
  type ImportPreview,
  type ImportResult,
} from "../../../src/memory/import-format.js";
import { ScopeChips } from "./memory-detail.js";

export function RuleImport({
  repositories,
  initialTarget,
  mode,
  close,
  imported,
}: {
  repositories: Repository[];
  initialTarget: string;
  mode: "markdown" | "project";
  close: () => void;
  imported: (result: ImportResult, target: number) => Promise<void>;
}) {
  const [target, setTarget] = useState(initialTarget === "ALL" ? "" : initialTarget);
  const [source, setSource] = useState("");
  const [rules, setRules] = useState<Memory[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [document, setDocument] = useState<{ name: string; text: string }>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  useEffect(() => {
    setRules([]);
    setChosen([]);
    setPaths({});
    setError("");
    setLoading(false);
    if (!source) return;
    const controller = new AbortController();
    setLoading(true);
    void api<Memory[]>(`/api/repositories/${source}/rule-import/source`, { signal: controller.signal })
      .then((items) => {
        setRules(items);
        setPaths(Object.fromEntries(items.map((item) => [item.id, (item.scope.paths ?? []).join("\n")])));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [source]);
  async function buildPreview() {
    setBusy(true);
    setError("");
    try {
      const input =
        mode === "markdown"
          ? { kind: mode, documentName: document!.name, markdown: document!.text }
          : {
              kind: mode,
              sourceRepositoryId: Number(source),
              rules: chosen.map((id) => ({
                id,
                paths: paths[id]!.split("\n")
                  .map((path) => path.trim())
                  .filter(Boolean),
              })),
            };
      const value = await api<ImportPreview>(`/api/repositories/${target}/rule-import/preview`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      setPreview(value);
      setSelected(value.rules.map((rule) => rule.key));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const value = await api<ImportResult>(`/api/repositories/${target}/rule-import/confirm`, {
        method: "POST",
        body: JSON.stringify({ previewId: preview!.id, keys: selected }),
      });
      setResult(value);
      await imported(value, Number(target));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((item) => item !== id) : [...values, id];
  const shown = rules.filter((rule) => `${rule.title} ${rule.content}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal
      drawer
      titleId="import-title"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <div className="drawer-head">
        <span className="eyebrow">团队规则 · 导入</span>
        <button className="icon-button" aria-label="关闭导入" disabled={busy} onClick={close}>
          ×
        </button>
      </div>
      <div className="drawer-body rule-import">
        <h2 id="import-title">{mode === "markdown" ? "从 Markdown 导入" : "从其他项目导入"}</h2>
        <p className="muted">1. 选择规则与目标项目 → 2. 预览 → 3. 确认生效</p>
        <label>
          目标项目
          <select
            value={target}
            disabled={busy || Boolean(preview)}
            onChange={(event) => {
              setTarget(event.target.value);
              if (source === event.target.value) setSource("");
            }}
          >
            <option value="">请选择目标项目</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {result ? (
          <p className="feedback" role="status">
            已导入并生效 {result.imported.length} 条，跳过 {result.skipped.length} 条重复规则。可以关闭窗口查看规则。
          </p>
        ) : preview ? (
          <>
            <h3>确认这些规则</h3>
            <p className="muted">
              选中 {selected.length} / {preview.rules.length} 条。确认后立即用于目标项目的后续审查和开发任务。预览 30
              分钟内有效。
            </p>
            <p>重复规则会跳过，已有规则保留原状态。同名提示只做内容比较，请人工核对语义冲突。</p>
            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setSelected(preview.rules.map((rule) => rule.key))}
              >
                全选
              </button>
              <button className="secondary" disabled={busy} onClick={() => setSelected([])}>
                清空选择
              </button>
            </div>
            {preview.rules.map((rule) => (
              <article className="card import-rule" key={rule.key}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={selected.includes(rule.key)}
                    disabled={busy}
                    onChange={() => setSelected(toggle(selected, rule.key))}
                  />
                  <strong>{rule.title}</strong>
                </label>
                <small>
                  {Object.entries(IMPORT_TYPES).find(([, type]) => type === rule.type)?.[0]} ·{" "}
                  {memorySourceLabel(rule.source)}
                </small>
                <ScopeChips scope={rule.scope} />
                {rule.duplicateId && (
                  <p className="feedback">
                    完全重复：与本批或目标项目中的规则相同，确认时仅保留一份，不会覆盖或重新激活已有规则。
                  </p>
                )}
                {rule.sameTitleIds.length > 0 && (
                  <p className="alert">存在同名但内容或范围不同的规则，确认后作为独立新规则生效，请核对冲突。</p>
                )}
                {rule.exceptionKey && (
                  <p>
                    例外关联：
                    {preview.rules.find((parent) => parent.key === rule.exceptionKey)?.title ?? rule.exceptionKey}
                    （需要同时选择原规则，或目标项目已有生效副本）
                  </p>
                )}
                <details open>
                  <summary>规则内容与制定原因</summary>
                  <p className="rule-content">{rule.content}</p>
                  <h4>制定原因</h4>
                  <p className="rule-content">{rule.rationale}</p>
                </details>
                {rule.evidence.length > 0 && (
                  <details>
                    <summary>参考依据（{rule.evidence.length} 项）</summary>
                    {rule.evidence.map((item, index) => (
                      <p key={index} className="rule-content">
                        {item.detail}
                        <br />
                        {item.reference}
                      </p>
                    ))}
                  </details>
                )}
                {rule.uncertainties.length > 0 && <p className="alert">待核实：{rule.uncertainties.join("；")}</p>}
              </article>
            ))}
          </>
        ) : mode === "markdown" ? (
          <>
            <h3>先按示例整理文档</h3>
            <p>
              每条规则使用「## 编号｜名称」，类型、适用路径、规则内容和制定原因必填。编号在文档内唯一；最多 100 条、512
              KiB。路径用反引号包裹，以顿号分隔；全局规则填写「整个仓库」。
            </p>
            <details open>
              <summary>Markdown 格式示例</summary>
              <pre className="import-example">{RULE_IMPORT_EXAMPLE}</pre>
            </details>
            <button
              className="secondary"
              onClick={() => {
                if (!navigator.clipboard) {
                  setError("当前浏览器不支持复制，请手动选择示例文字复制。");
                  return;
                }
                void navigator.clipboard
                  .writeText(RULE_IMPORT_EXAMPLE)
                  .then(() => setCopied(true))
                  .catch(() => setError("无法复制，请手动选择示例文字复制。"));
              }}
            >
              {copied ? "已复制示例" : "复制格式示例"}
            </button>
            <p className="muted">
              支持类型：{Object.keys(IMPORT_TYPES).join("、")}
              。例外规则还需填写「例外关联：同一文档内的原规则编号」，且必须限定路径。可选栏目为「适用条件与例外」「参考依据」；其他栏目会报错，请先整理格式。
            </p>
            <label>
              选择 Markdown 文件
              <input
                type="file"
                accept=".md,text/markdown"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setDocument(undefined);
                  setError("");
                  if (!file) return;
                  if (file.size > MAX_MARKDOWN_BYTES) {
                    setError("Markdown 超过 512 KiB");
                    return;
                  }
                  setBusy(true);
                  void file
                    .text()
                    .then((text) => setDocument({ name: file.name, text }))
                    .catch(() => setError("文件读取失败，请重新选择。"))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
            {document && <p role="status">已读取 {document.name}，尚未导入。</p>}
          </>
        ) : (
          <>
            <p>复制为目标项目的独立规则，保留原项目、规则编号与版本。后续修改不会自动同步。</p>
            <label>
              来源项目
              <select value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}>
                <option value="">请选择来源项目</option>
                {repositories
                  .filter((repo) => String(repo.id) !== target)
                  .map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              搜索来源规则
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索名称或内容"
              />
            </label>
            {loading ? (
              <p role="status">正在加载生效规则…</p>
            ) : source && !rules.length ? (
              <p>来源项目暂无生效规则。</p>
            ) : null}
            <p className="muted">
              已选 {chosen.length} 条（最多 100 条）。路径每行一项，留空表示不限制路径；原有语言、模块和条件限制保留。
            </p>
            {shown.map((rule) => (
              <article className="card import-rule" key={rule.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(rule.id)}
                    disabled={busy}
                    onChange={() => setChosen(toggle(chosen, rule.id))}
                  />
                  <strong>{rule.title}</strong>
                </label>
                <ScopeChips scope={rule.scope} />
                <details>
                  <summary>查看规则 v{rule.version}</summary>
                  <p className="rule-content">{rule.content}</p>
                  <p className="rule-content">{rule.rationale}</p>
                </details>
                {chosen.includes(rule.id) && (
                  <label>
                    在目标项目的适用路径
                    <textarea
                      value={paths[rule.id] ?? ""}
                      disabled={busy}
                      onChange={(event) => setPaths({ ...paths, [rule.id]: event.target.value })}
                    />
                  </label>
                )}
              </article>
            ))}
          </>
        )}
      </div>
      <footer className="drawer-footer">
        {result ? (
          <button onClick={close}>完成</button>
        ) : (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (preview) {
                  setPreview(undefined);
                  setError("");
                } else close();
              }}
            >
              {preview ? "返回调整" : "取消"}
            </button>
            {preview ? (
              <button disabled={busy || !selected.length} onClick={() => void confirm()}>
                {busy ? "正在确认…" : "确认导入并生效"}
              </button>
            ) : (
              <button
                disabled={
                  busy ||
                  loading ||
                  !target ||
                  (mode === "markdown" ? !document : !source || !chosen.length || chosen.length > 100)
                }
                onClick={() => void buildPreview()}
              >
                {busy ? "校验中…" : "校验并预览"}
              </button>
            )}
          </>
        )}
      </footer>
    </Modal>
  );
}
