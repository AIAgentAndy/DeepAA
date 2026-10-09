import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {migrateDeepaaDatabase, SCHEMA_VERSION} from "../src/lib/db/schema.js";
import {
  ackCatalogNotifications,
  litellmChangeRevision,
  loadCatalogNotification,
  manualChangeRevision,
  queryCatalogNotifications,
  recordCatalogNotification,
  recordPriceChange,
} from "../src/lib/provider-catalog/notification-store.js";

/**
 * 模型价格变动通知（2026-09-10 用户决策）：官方预设 / 人工覆盖 / LiteLLM 三种来源
 * 共用一张表；人工与 LiteLLM 只作可查流水，不影响官方目录映射与计价优先级。
 */

function fixture(): {db: DeepaaDatabase; close: () => void} {
  const dir = mkdtempSync(join(tmpdir(), "catalog-notifications-"));
  const db = new DeepaaDatabase(join(dir, "test.sqlite"));
  migrateDeepaaDatabase(db);
  return {db, close: () => {db.close(); rmSync(dir, {recursive: true, force: true});}};
}

const officialNotification = {
  catalogRevision: "2026.09.10.02",
  publishedAt: "2026-09-10T14:00:00+08:00",
  createdAt: "2026-09-10T06:00:00.000Z",
  effectiveFrom: "2026-09-10T12:00:00+08:00",
  items: [{
    vendor: "deepseek",
    providerName: "DeepSeek（官方）",
    modelId: "deepseek-v4-flash",
    changes: [{field: "input", label: "非缓存输入价", before: "3/M", after: "2/M", kind: "changed" as const}],
    changeNote: "官方公告：9 月 10 日 12:00 起调整 flash 系列定价",
    inUse: true,
  }],
};

test("schema v26：通知表带变更来源列且来源索引存在", () => {
  const {db, close} = fixture();
  try {
    assert.equal(db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    const columns = db.pragma("table_info(catalog_update_notifications)") as Array<{name: string}>;
    assert.equal(columns.some(column => column.name === "source"), true);
    const indexes = db.pragma("index_list(catalog_update_notifications)") as Array<{name: string}>;
    assert.equal(indexes.some(index => index.name === "idx_catalog_notifications_source"), true);
  } finally {
    close();
  }
});

test("同版本内容感知幂等：items 无变化保持已阅，实质变化重置未阅并刷新时刻（2026-09-21）", () => {
  const {db, close} = fixture();
  try {
    recordCatalogNotification(db, officialNotification);
    ackCatalogNotifications(db, {revisions: ["2026.09.10.02"]}, "2026-09-10T07:00:00.000Z");
    let row = loadCatalogNotification(db, "2026.09.10.02")!;
    assert.equal(row.ackedAt !== undefined, true);

    // 内容一致的重放：保持已阅，不打扰。
    recordCatalogNotification(db, officialNotification);
    row = loadCatalogNotification(db, "2026.09.10.02")!;
    assert.equal(row.ackedAt !== undefined, true, "同内容重放不得重置已阅");

    // 同版本但 items 实质变化（例如新增能力字段变化项）：必须重新点亮为未阅。
    const changedItems = [{
      vendor: "deepseek",
      providerName: "DeepSeek（官方）",
      modelId: "deepseek-v4-flash",
      changes: [{field: "inputModalities", label: "输入模态", before: "text", after: "text / image", kind: "changed" as const}],
      inUse: true,
    }];
    recordCatalogNotification(db, {...officialNotification, createdAt: "2026-09-21T15:00:00.000Z", items: changedItems});
    row = loadCatalogNotification(db, "2026.09.10.02")!;
    assert.equal(row.ackedAt, undefined, "同版本新内容必须重置未阅");
    assert.equal(row.createdAt, "2026-09-21T15:00:00.000Z");
    assert.equal(row.items[0]?.changes[0]?.field, "inputModalities");
  } finally {
    close();
  }
});

test("官方预设记录：来源缺省 official_preset，摘要用公告文案", () => {
  const {db, close} = fixture();
  try {
    recordCatalogNotification(db, officialNotification);
    const page = queryCatalogNotifications(db, {});
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.source, "official_preset");
    assert.match(page.rows[0]?.summary ?? "", /官方公告/u);
    assert.equal(page.rows[0]?.inUseCount, 1);
    assert.equal(loadCatalogNotification(db, "2026.09.10.02")?.items.length, 1);
  } finally {
    close();
  }
});

test("人工覆盖与 LiteLLM 记录：版本号前缀区分且摘要带来源前缀", () => {
  const {db, close} = fixture();
  try {
    const at = new Date("2026-09-10T17:17:59+08:00");
    recordPriceChange(db, {
      source: "manual_override",
      revision: manualChangeRevision(at),
      changedAt: at,
      entries: [{
        vendor: "deepseek", modelId: "deepseek-v4-flash",
        changes: [{field: "input", label: "非缓存输入价", before: "3/M", after: "1/M", kind: "changed"}],
      }],
    });
    recordPriceChange(db, {
      source: "litellm_auto",
      revision: litellmChangeRevision(at),
      changedAt: at,
      entries: [{
        vendor: "openai", modelId: "gpt-5.6-sol",
        changes: [{field: "output", label: "输出价", before: "30/M", after: "28/M", kind: "changed"}],
      }],
    });
    const rows = queryCatalogNotifications(db, {}).rows;
    const manual = rows.find(row => row.source === "manual_override");
    const litellm = rows.find(row => row.source === "litellm_auto");
    assert.ok(manual?.catalogRevision.startsWith("manual-"), manual?.catalogRevision);
    assert.ok(litellm?.catalogRevision.startsWith("litellm-"), litellm?.catalogRevision);
    assert.match(manual?.summary ?? "", /^【人工覆盖】/u);
    assert.match(litellm?.summary ?? "", /^【LiteLLM】/u);
  } finally {
    close();
  }
});

test("来源筛选：只返回命中的来源；空数组 = 不过滤", () => {
  const {db, close} = fixture();
  try {
    recordCatalogNotification(db, officialNotification);
    const at = new Date("2026-09-10T17:17:59+08:00");
    recordPriceChange(db, {
      source: "manual_override", revision: manualChangeRevision(at), changedAt: at,
      entries: [{vendor: "deepseek", modelId: "deepseek-v4-flash", changes: [{field: "input", label: "输入价", after: "1/M", kind: "changed"}]}],
    });
    assert.equal(queryCatalogNotifications(db, {sources: []}).total, 2);
    assert.equal(queryCatalogNotifications(db, {sources: ["manual_override"]}).total, 1);
    assert.equal(queryCatalogNotifications(db, {sources: ["official_preset"]}).rows[0]?.catalogRevision, "2026.09.10.02");
  } finally {
    close();
  }
});

test("无有效变更时不落库；已阅/未阅筛选与批量已阅幂等", () => {
  const {db, close} = fixture();
  try {
    const at = new Date("2026-09-10T17:17:59+08:00");
    // changes 为空 → 不产生记录。
    assert.equal(recordPriceChange(db, {source: "manual_override", revision: manualChangeRevision(at), changedAt: at, entries: [{vendor: "v", modelId: "m", changes: []}]}), undefined);
    assert.equal(queryCatalogNotifications(db, {}).total, 0);
    recordCatalogNotification(db, officialNotification);
    assert.equal(queryCatalogNotifications(db, {acked: ["unread"]}).total, 1);
    const first = ackCatalogNotifications(db, {revisions: ["2026.09.10.02"]}, "2026-09-10T07:00:00.000Z");
    assert.equal(first, 1);
    // 重复已阅幂等：不再更新已阅时间。
    assert.equal(ackCatalogNotifications(db, {revisions: ["2026.09.10.02"]}, "2026-09-10T08:00:00.000Z"), 0);
    assert.equal(queryCatalogNotifications(db, {acked: ["read"]}).rows[0]?.ackedAt, "2026-09-10T07:00:00.000Z");
    assert.equal(queryCatalogNotifications(db, {acked: ["unread"]}).total, 0);
  } finally {
    close();
  }
});

test("有界裁剪：已阅按时间裁剪到上限，未阅始终保留", () => {
  const {db, close} = fixture();
  try {
    const insert = (revision: string, index: number) => recordPriceChange(db, {
      source: "litellm_auto",
      revision,
      changedAt: new Date(Date.UTC(2026, 8, 10, 0, index)),
      entries: [{vendor: "openai", modelId: `m-${index}`, changes: [{field: "input", label: "输入价", after: "1/M", kind: "changed"}]}],
    });
    for (let index = 0; index < 210; index += 1) insert(`litellm-a-${String(index).padStart(6, "0")}`, index);
    // 全部已阅 → 裁剪到上限 200（保留最新）。
    ackCatalogNotifications(db, {all: true}, "2026-09-10T09:00:00.000Z");
    insert("litellm-b-000001", 300);
    assert.equal(queryCatalogNotifications(db, {}).total, 200);
    // 混入未阅：未阅不参与裁剪，已阅让位。
    insert("litellm-c-000001", 301);
    insert("litellm-c-000002", 302);
    // 未阅共 3 条（litellm-b + 两条 litellm-c）：不参与裁剪，已阅让位保持总数上限。
    const page = queryCatalogNotifications(db, {});
    assert.equal(page.unreadCount, 3);
    assert.equal(page.total, 200);
    assert.equal(queryCatalogNotifications(db, {acked: ["unread"]}).total, 3);
  } finally {
    close();
  }
});
