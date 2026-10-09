import { describe, expect, test } from "vitest";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

const LEGACY_FILES = [
  "src/lib/local-config-reader.ts",
  "src/lib/local-config-writer.ts",
  "src/app/api/local-config/route.ts",
  "bin/development-bootstrap.mjs",
];

describe("development launch source boundaries", () => {
  test("removes legacy local config scanning and writing", async () => {
    for (const path of LEGACY_FILES) {
      expect(existsSync(path), `${path} should be removed`).toBe(false);
    }
    expect(existsSync("src/components/proxy-settings-dialog.tsx")).toBe(false);
    const component = await readFile("src/components/proxy-management-page.tsx", "utf-8");
    expect(component).not.toContain("/api/local-config");
    expect(component).not.toContain("本地配置检测");
    expect(component).not.toContain("一键应用到本地配置");
    expect(component).not.toContain("applyTargetToLocal");
  });

  test("一次性计划只用于 Terminal.app 超长命令且 Windows 保持直接启动", async () => {
    const directLaunchPaths = [
      "src/lib/development-launch/service.ts",
      "src/lib/development-launch/launch-plan.ts",
      "src/lib/development-launch/terminal-launcher.ts",
      "src/lib/development-launch/platform-windows.ts",
    ];
    const directSource = (await Promise.all(
      directLaunchPaths.map(path => readFile(path, "utf-8")),
    )).join("\n");
    const macSource = await readFile(
      "src/lib/development-launch/platform-macos.ts",
      "utf-8",
    );
    const windowsSource = await readFile(
      "src/lib/development-launch/platform-windows.ts",
      "utf-8",
    );

    expect(directSource).not.toContain("development-bootstrap");
    expect(directSource).not.toContain("terminal-launch.json");
    expect(directSource).not.toContain("windowsWrapperPath");
    expect(macSource).toContain("TERMINAL_APP_DIRECT_COMMAND_MAX_BYTES = 1024");
    expect(macSource).toContain('input.terminalId !== "terminal.app"');
    expect(windowsSource).not.toContain("terminal-launch");
    expect(existsSync("bin/development-launch.mjs")).toBe(true);
  });
});
