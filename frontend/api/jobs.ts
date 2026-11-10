import { useEffect, useState } from "react";
import { api, messageOf } from "./client.js";
import type { JobPage } from "../types.js";

// 读取一页任务；筛选条件或页码变化时重新请求，旧请求取消。
export function useJobPage(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined || value === "" ? [] : [[key, String(value)]],
    ),
  ).toString();
  const [data, setData] = useState<JobPage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<JobPage>(`/api/jobs?${query}`, { signal: controller.signal })
      .then((value) => {
        setData(value);
        setError("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);
  return { data, loading, error };
}
