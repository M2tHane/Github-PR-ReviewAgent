import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { dateText } from "../format.js";
import type { ServiceSettingsResponse, SettingDefinition, SettingValue } from "../types.js";

// 页面上的输入都是字符串；数值按定义的单位换算，保存时只提交改过的项。
function display(definition: SettingDefinition, value: SettingValue | undefined) {
  if (value === undefined) return "默认值";
  if (value === null) return definition.empty ?? "—";
  if (definition.kind === "boolean") return value ? "开" : "关";
  if (definition.kind !== "integer") return String(value);
  if (value === 0 && definition.zero) return definition.zero;
  const amount = Number(value) / (definition.scale ?? 1);
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${definition.unit ? ` ${definition.unit}` : ""}`;
}

function toInput(definition: SettingDefinition, value: SettingValue) {
  if (value === null) return "";
  if (definition.kind === "boolean") return value ? "on" : "";
  if (definition.kind === "integer") return String(Number(value) / (definition.scale ?? 1));
  return String(value);
}

function fromInput(definition: SettingDefinition, text: string): SettingValue {
  if (definition.kind === "boolean") return text === "on";
  if (!text.trim()) return definition.empty ? null : "";
  if (definition.kind === "integer") return Math.round(Number(text) * (definition.scale ?? 1));
  return text.trim();
}

const shrinks = (key: string, before: SettingValue, after: SettingValue) =>
  (key === "DATA_RETENTION_DAYS" || key === "REVOKED_DATA_GRACE_DAYS") &&
  typeof after === "number" &&
  after > 0 &&
  (before === 0 || (typeof before === "number" && after < before));

export function ServiceSettingsPage() {
  const [data, setData] = useState<ServiceSettingsResponse | null>(null),
    [inputs, setInputs] = useState<Record<string, string>>({}),
    [reset, setReset] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");

  function show(value: ServiceSettingsResponse) {
    setData(value);
    setReset([]);
    const byKey = new Map(value.definitions.map((item) => [item.key, item]));
    setInputs(Object.fromEntries(value.settings.map((item) => [item.key, toInput(byKey.get(item.key)!, item.value)])));
  }

  useEffect(() => {
    api<ServiceSettingsResponse>("/api/service-settings")
      .then(show)
      .catch((cause) => setError(messageOf(cause)));
  }, []);

  if (!data)
    return error ? (
      <p className="alert" role="alert">
        {error}
      </p>
    ) : (
      <p role="status">正在加载服务设置…</p>
    );

  const definitions = new Map(data.definitions.map((item) => [item.key, item]));
  const states = data.settings.map((state) => ({ state, definition: definitions.get(state.key)! }));
  const groups = [...new Set(states.map((item) => item.definition.group))];
  const changed = states.filter(
    ({ state, definition }) => !reset.includes(state.key) && inputs[state.key] !== toInput(definition, state.value),
  );

  async function save() {
    const values: Record<string, SettingValue> = {};
    for (const { state, definition } of changed) values[state.key] = fromInput(definition, inputs[state.key] ?? "");
    const shrinking = [
      ...Object.entries(values).filter(([key, value]) => {
        const state = data!.settings.find((item) => item.key === key)!;
        return shrinks(key, state.value, value);
      }),
      ...reset
        .map((key) => data!.settings.find((item) => item.key === key)!)
        .filter((state) => shrinks(state.key, state.value, state.defaultValue))
        .map((state) => [state.key, state.defaultValue] as const),
    ];
    if (
      shrinking.length &&
      !window.confirm(
        `${shrinking.map(([key, value]) => `${definitions.get(key)!.label}改为 ${display(definitions.get(key)!, value)}`).join("、")}。下一次清理会删除超出期限的数据，删除后不能恢复。确定保存吗？`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      show(
        await api<ServiceSettingsResponse>("/api/service-settings", {
          method: "PUT",
          body: JSON.stringify({ values, reset }),
        }),
      );
      setNotice("已保存。最多 30 秒后所有实例都按新值运行，正在执行的任务不受影响。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="service-settings">
      <div className="section-head">
        <div>
          <h2>服务设置</h2>
          <p className="muted">
            对所有仓库生效。没改过的项用 .env 或代码里的默认值；密钥、地址和允许的仓库列表只能在 .env 修改。
          </p>
        </div>
      </div>
      {!data.canEdit && (
        <p className="feedback" role="status">
          {data.adminsConfigured
            ? "你可以查看这些设置；只有 .env 里 SERVICE_ADMINS 列出的用户可以修改。"
            : "还没有指定可以修改的人：在 .env 设置 SERVICE_ADMINS=GitHub 用户名（多个用逗号分隔），重启服务后生效。"}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {groups.map((group) => (
          <fieldset className="card service-settings-group" key={group} disabled={!data.canEdit || busy}>
            <legend>{group}</legend>
            {states
              .filter((item) => item.definition.group === group)
              .map(({ state, definition }) => {
                const id = `setting-${state.key}`,
                  pendingReset = reset.includes(state.key),
                  text = pendingReset ? toInput(definition, state.defaultValue) : (inputs[state.key] ?? ""),
                  scale = definition.scale ?? 1,
                  edit = (value: string) => {
                    setReset((items) => items.filter((key) => key !== state.key));
                    setInputs((items) => ({ ...items, [state.key]: value }));
                  };
                return (
                  <div className="service-setting" key={state.key}>
                    <div className="service-setting-label">
                      <label htmlFor={id}>{definition.label}</label>
                      {definition.help && <p className="muted">{definition.help}</p>}
                      <p className="service-setting-source">
                        {state.updatedBy
                          ? `${state.updatedBy} 修改于 ${dateText(state.updatedAt)} · 默认 ${display(definition, state.defaultValue)}`
                          : "使用默认值"}
                        {pendingReset && " · 保存后恢复默认"}
                      </p>
                    </div>
                    <div className="service-setting-input">
                      {definition.kind === "boolean" ? (
                        <label className="check">
                          <input
                            id={id}
                            type="checkbox"
                            checked={text === "on"}
                            onChange={(event) => edit(event.currentTarget.checked ? "on" : "")}
                          />
                          {text === "on" ? "开" : "关"}
                        </label>
                      ) : definition.kind === "choice" ? (
                        <select id={id} value={text} onChange={(event) => edit(event.currentTarget.value)}>
                          {definition.empty && <option value="">{definition.empty}</option>}
                          {definition.choices!.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      ) : definition.kind === "integer" ? (
                        <span className="service-setting-number">
                          <input
                            id={id}
                            type="number"
                            inputMode="numeric"
                            // .env 的默认值可能不是整单位（如 90 秒显示为 1.5 分钟），不能让浏览器因此拦下整张表单；整单位由服务端校验。
                            step="any"
                            min={definition.zero ? 0 : definition.min! / scale}
                            max={definition.max! / scale}
                            required={!definition.empty}
                            placeholder={definition.empty}
                            value={text}
                            onChange={(event) => edit(event.currentTarget.value)}
                          />
                          <span>{definition.unit ?? ""}</span>
                        </span>
                      ) : (
                        <input
                          id={id}
                          required
                          maxLength={100}
                          value={text}
                          onChange={(event) => edit(event.currentTarget.value)}
                        />
                      )}
                      {definition.zero && <small className="muted">填 0 表示{definition.zero}</small>}
                      {state.updatedBy && !pendingReset && data.canEdit && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setReset((items) => [...items, state.key])}
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </fieldset>
        ))}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="feedback" role="status">
            {notice}
          </p>
        )}
        {data.canEdit && (
          <div className="service-settings-foot">
            <button type="submit" disabled={busy || (!changed.length && !reset.length)}>
              {busy ? "保存中…" : "保存修改"}
            </button>
            <small className="muted">
              {changed.length || reset.length ? `${changed.length + reset.length} 项待保存` : "没有改动"}
            </small>
          </div>
        )}
      </form>
      <h3 className="service-settings-audit-title">最近修改</h3>
      {data.audits.length ? (
        <div className="table-wrap">
          <table className="service-settings-audits" aria-label="服务设置修改记录">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">修改人</th>
                <th scope="col">设置</th>
                <th scope="col">改动</th>
              </tr>
            </thead>
            <tbody>
              {data.audits.map((audit, index) => {
                const definition = definitions.get(audit.key);
                return (
                  <tr key={`${audit.createdAt}-${index}`}>
                    <td data-label="时间">{dateText(audit.createdAt)}</td>
                    <td data-label="修改人">{audit.actor}</td>
                    <td data-label="设置">{definition?.label ?? audit.key}</td>
                    <td data-label="改动">
                      {definition
                        ? `${display(definition, audit.oldValue)} → ${display(definition, audit.newValue)}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">还没有人修改过。</p>
      )}
    </section>
  );
}
