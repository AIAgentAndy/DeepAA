import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // SQLite 驱动为 Node 内置 node:sqlite（经 src/lib/db/sqlite-driver.ts 统一层），
  // 无原生外部包，无需 serverExternalPackages。
  // 隔离验证用：DEEPAA_NEXT_DIST_DIR 指向独立目录时，dev 实例不读写在线
  // `next start` 实例正在服务的 .next，避免并行验证污染生产构建产物。
  distDir: process.env.DEEPAA_NEXT_DIST_DIR || ".next",
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingIncludes: {
    "/*": [
      "./data/defaults/litellm-model-prices.snapshot.json",
      "./data/defaults/llm_catalog.jsonl",
    ],
  },
  // 这些路径都是安装后才产生的运行时状态或源码，不属于 Next 服务发布产物。
  outputFileTracingExcludes: {
    "/*": [
      "./data/blobs/**/*",
      "./data/captures/**/*",
      "./data/config/**/*",
      "./data/*.sqlite*",
      "./data/proxy-config.json",
      "./data/proxy-routing-status.json",
      "./src/**/*",
      "./tests/**/*",
      "./next.config.ts",
    ],
  },
};

export default nextConfig;
