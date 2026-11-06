import { setTimeout as delay } from "node:timers/promises";
import { WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
import type { Config } from "../config/config.js";
import type { GitHubClient } from "../github/client.js";
import { log } from "../logging.js";
import type { DevelopmentStore } from "./store.js";
import { createDevelopmentProcessor } from "./processor.js";
import { downloadImage } from "./images.js";
import { developmentMessage, markdownText, parseGroupMessage } from "./messages.js";
import { DevelopmentError, type DevelopmentSettings, type DevelopmentTask } from "./types.js";

export class DevelopmentWorker {
  private readonly stopSignal = new AbortController();
  private active?: Promise<void>;
  constructor(
    private config: Config,
    private store: DevelopmentStore,
    github: GitHubClient,
    private process = createDevelopmentProcessor(config, store, github),
  ) {}
  start() {
    this.active = this.run();
  }
  async stop() {
    this.stopSignal.abort();
    await this.active;
  }
  private async run() {
    const config = this.config.development!;
    while (!this.stopSignal.signal.aborted) {
      try {
        await this.store.withLeader(config.botId, async (connection) => {
          const disconnected = new AbortController();
          const signal = AbortSignal.any([this.stopSignal.signal, disconnected.signal]);
          const connectionError = () => disconnected.abort(new Error("开发 Worker 数据库连接断开"));
          connection.on("error", connectionError);
          const bot = new WSClient({
            botId: config.botId,
            secret: config.secret,
            wsOptions: { maxPayload: 1_048_576 },
            // SDK 的原始错误或调试日志可能包含消息与凭据，只记录固定的运行事件。
            logger: {
              debug() {},
              info() {},
              warn() {
                log("info", "wecom_bot_warning", {});
              },
              error() {
                log("error", "wecom_bot_error", {});
              },
            },
          });
          const incoming = new Set<Promise<void>>();
          let authenticated = false;
          let lastSent = 0;
          let sending = Promise.resolve();
          const send = (operation: () => Promise<unknown>) => {
            const result = sending.then(async () => {
              signal.throwIfAborted();
              const wait = Math.max(0, lastSent + 3100 - Date.now());
              if (wait) await delay(wait, undefined, { signal });
              signal.throwIfAborted();
              lastSent = Date.now();
              const ack = (await operation()) as { errcode?: number };
              if (ack?.errcode !== 0) throw new Error("企微未确认消息发送成功");
            });
            sending = result.catch(() => undefined); // 调用方记录每次发送失败，不影响下一条明确未发送的消息。
            return result;
          };
          bot.on("authenticated", () => {
            authenticated = true;
          });
          bot.on("disconnected", () => {
            authenticated = false;
          });
          bot.on("error", () => {
            log("error", "wecom_bot_connection_error", {});
          });
          const receive = async (frame: WsFrame) => {
            if (frame.body?.chattype !== "group" || frame.body?.aibotid !== config.botId) return;
            let requester: string | undefined;
            try {
              const request = parseGroupMessage(frame.body, config.botId);
              requester = request.requester;
              if (
                (
                  await this.store.pool.query("SELECT id FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
                    config.botId,
                    request.messageId,
                  ])
                ).rowCount
              )
                return;
              const binding = (
                await this.store.pool.query(
                  `SELECT s.members,r.full_name FROM development_settings s JOIN repositories r ON r.id=s.repository_id
                WHERE s.chat_id=$1 AND s.enabled AND r.enabled AND r.revoked_at IS NULL`,
                  [request.chatId],
                )
              ).rows[0];
              if (!binding || !this.config.allowedRepositories.has(binding.full_name.toLowerCase()))
                throw new DevelopmentError(
                  "此群未绑定已启用的开发仓库，请联系管理员。群 ID：" + request.chatId,
                  "refused",
                );
              if (!(binding.members as DevelopmentSettings["members"]).some((m) => m.userid === request.requester))
                throw new DevelopmentError("你没有该仓库的开发任务权限，请联系管理员设置身份。", "refused");
              const images = [];
              for (const image of request.images) images.push(await downloadImage(image, signal));
              signal.throwIfAborted();
              const result = await this.store.accept(config.botId, { ...request, images }, this.config);
              if (result === "accepted") {
                await send(() =>
                  bot.replyStream(
                    frame,
                    request.messageId,
                    `<@${request.requester}>\n\n已收到开发任务，完成后会在本群通知你。`,
                    true,
                  ),
                ).catch(() => log("error", "wecom_development_ack_uncertain", {}));
              }
            } catch (error) {
              if (signal.aborted) return;
              const message =
                error instanceof DevelopmentError ? error.message : "接收开发任务失败，请检查接入配置后重新发送。";
              // 身份格式无效时不回显 userid，不允许伪造 @all 或其他成员。
              await send(() =>
                bot.replyStream(
                  frame,
                  `error-${Date.now()}`,
                  `${requester ? `<@${requester}>\n\n` : ""}${markdownText(message)}`,
                  true,
                ),
              );
            }
          };
          bot.on("message", (frame: WsFrame) => {
            if (signal.aborted || frame.body?.chattype !== "group" || frame.body?.aibotid !== config.botId) return;
            // 两条图文正在下载或确认时，明确告知新请求稍后重发，不能静默丢弃。
            const operation =
              incoming.size >= 2
                ? bot.replyStream(frame, `busy-${Date.now()}`, "当前正在接收其他开发任务，请稍后重新 @Bot 发送。", true)
                : receive(frame);
            const work = operation
              .then(() => undefined)
              .catch(() => log("error", "wecom_development_receive_failed", {}))
              .finally(() => incoming.delete(work));
            incoming.add(work);
          });
          const process = this.process;
          const disconnect = () => bot.disconnect();
          signal.addEventListener("abort", disconnect, { once: true });
          try {
            await this.store.recover(config.botId);
            bot.connect();
            while (!signal.aborted) {
              // 用持锁连接探活；连接失败会终止这一实例，不能继续领取或发布任务。
              await connection.query("SELECT 1");
              if (authenticated) {
                const task = await this.store.claim(config.botId);
                if (task) await process(task, signal);
                const result = await this.store.pool.query(
                  `UPDATE development_tasks SET notification_status='sending' WHERE id=(
                  SELECT id FROM development_tasks WHERE bot_id=$1 AND status NOT IN ('queued','running','publishing') AND notification_status='pending'
                  ORDER BY created_at LIMIT 1) RETURNING *`,
                  [config.botId],
                );
                const notification = result.rows[0] as DevelopmentTask | undefined;
                if (notification) {
                  try {
                    await send(() => bot.sendMessage(notification.chat_id, developmentMessage(notification)));
                    await this.store.pool.query("UPDATE development_tasks SET notification_status='sent' WHERE id=$1", [
                      notification.id,
                    ]);
                  } catch {
                    await this.store.pool.query(
                      "UPDATE development_tasks SET notification_status='uncertain' WHERE id=$1",
                      [notification.id],
                    );
                    log("error", "wecom_development_notification_uncertain", { taskId: notification.id });
                  }
                }
              }
              await delay(2000, undefined, { signal });
            }
          } finally {
            disconnected.abort();
            bot.disconnect();
            await Promise.allSettled([...incoming]);
            await sending;
            signal.removeEventListener("abort", disconnect);
            connection.removeListener("error", connectionError);
          }
        });
      } catch {
        if (!this.stopSignal.signal.aborted) log("error", "wecom_development_worker_failed", {});
      }
      if (!this.stopSignal.signal.aborted)
        await delay(5000, undefined, { signal: this.stopSignal.signal }).catch(() => undefined);
    }
  }
}
