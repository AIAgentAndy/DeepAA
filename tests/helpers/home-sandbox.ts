import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

/**
 * Vitest 全局 HOME 沙箱：把 HOME（及 dsh/DeepAA 数据目录）指到临时目录，
 * 任何缺省解析到用户主目录的读写都落在沙箱内。2026-09-02 事故：某个测试
 * 调用 syncCliConfigs 时遗漏 Agent 路径，清理层把本机真实的
 * ~/.dsh、~/.config/opencode、~/.zcode 受管配置清空。此沙箱保证该类
 * 测试隔离缺陷不再伤害真实环境。
 */
const sandbox = mkdtempSync(join(tmpdir(), "deepaa-vitest-home-"));
process.env.HOME = sandbox;
process.env.DSH_HOME ??= join(sandbox, ".dsh");
process.env.DEEPAA_DATA_DIR ??= join(sandbox, ".deepaa");
