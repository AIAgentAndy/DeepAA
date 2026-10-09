import { redirect } from "next/navigation";

/** 仪表盘是应用默认首页：根路径直接进入汇总台，会话追踪迁移至 /sessions。 */
export default function HomePage() {
  redirect("/dashboard");
}
