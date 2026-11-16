import type React from "react";

// 详情页右侧属性栏：标签—值逐行排列；值为空的行不显示。
export function PropertyList({
  items,
  label,
}: {
  items: Array<[label: string, value: React.ReactNode] | false | null | undefined | 0 | "">;
  label?: string;
}) {
  return (
    <dl className="properties" aria-label={label}>
      {items
        .filter(
          (item): item is [string, React.ReactNode] => Array.isArray(item) && item[1] !== undefined && item[1] !== null,
        )
        .map(([name, value]) => (
          <div className="property" key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
