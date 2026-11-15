import { log } from "../logging.js";

// 两个信号接连到达时也只停止一次；完成任务回队、请求与发送收尾后才退出。
export function stopOnSignals(
  app: { stop(): Promise<void> },
  runtime: {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    exit(code: number): void;
  } = process,
) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const exit = (code: number) => {
      runtime.off("SIGINT", stop);
      runtime.off("SIGTERM", stop);
      runtime.exit(code);
    };
    void app.stop().then(
      () => exit(0),
      (error) => {
        log("error", "shutdown_failed", {}, error);
        exit(1);
      },
    );
  };
  runtime.on("SIGINT", stop);
  runtime.on("SIGTERM", stop);
}
