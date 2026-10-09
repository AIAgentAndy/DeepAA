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
// CI runner 会预设 XDG_CONFIG_HOME（ubuntu）/APPDATA（Windows）指向真实用户目录，
// 配置解析若优先读它们就会逃出沙箱/测试夹具的 homeDir（2026-10-10 CI 事故：
// OpenCode 全局配置解析因此读不到夹具文件）。与 HOME 同理删除，保证 homeDir 回退语义。
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;
