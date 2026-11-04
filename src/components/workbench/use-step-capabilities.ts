"use client";

/**
 * P1-3（2026-11-03）：Step 能力读取层——「响应」面板 / 请求摘要 / 能力清单共用。
 * 拉取 view=capability-summary + 三类 items 首页（tools/observed/skills，各 ≤50 条，
 * 全部走 SQLite 有界投影）；竞态防护：stepId 变化即中止旧请求，迟到 Promise 不落
 * 到新 Step 上。错误态显式呈现（「读取失败·重试」），不伪装成「没有能力」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StepCapabilityItemsPage,
  StepCapabilitySummary,
} from "@/lib/agent-harness/contracts";

export interface StepCapabilitiesData {
  summary?: StepCapabilitySummary;
  tools?: StepCapabilityItemsPage;
  observed?: StepCapabilityItemsPage;
  skills?: StepCapabilityItemsPage;
}

export type StepCapabilitiesState =
  | {phase: "loading"}
  | {phase: "ready"; data: StepCapabilitiesData; dataVersion: string}
  | {phase: "error"; message: string};

export function useStepCapabilities(stepId: string | undefined): StepCapabilitiesState & {reload: () => void} {
  const [state, setState] = useState<StepCapabilitiesState>({phase: "loading"});
  const [reloadToken, setReloadToken] = useState(0);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!stepId) {
      setState({phase: "loading"});
      return;
    }
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    setState({phase: "loading"});

    (async () => {
      try {
        const base = `/api/agent-steps/${encodeURIComponent(stepId)}/harness`;
        const [summaryRes, toolsRes, observedRes, skillsRes] = await Promise.all([
          fetch(`${base}?view=capability-summary`, {cache: "no-store", signal: controller.signal}),
          fetch(`${base}?view=capability-items&kind=tools`, {cache: "no-store", signal: controller.signal}),
          fetch(`${base}?view=capability-items&kind=observed`, {cache: "no-store", signal: controller.signal}),
          fetch(`${base}?view=capability-items&kind=skills`, {cache: "no-store", signal: controller.signal}),
        ]);
        if (seq !== requestSeqRef.current) return;
        if (summaryRes.status === 404) {
          setState({phase: "ready", data: {}, dataVersion: ""});
          return;
        }
        if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
        const summary = await summaryRes.json() as StepCapabilitySummary;
        const tools = toolsRes.ok ? await toolsRes.json() as StepCapabilityItemsPage : undefined;
        const observed = observedRes.ok ? await observedRes.json() as StepCapabilityItemsPage : undefined;
        const skills = skillsRes.ok ? await skillsRes.json() as StepCapabilityItemsPage : undefined;
        if (seq !== requestSeqRef.current) return;
        setState({
          phase: "ready",
          data: {
            summary,
            ...(tools ? {tools} : {}),
            ...(observed ? {observed} : {}),
            ...(skills ? {skills} : {}),
          },
          // 服务端 dataVersion(route 层透传)优先;缺失时回退 stepId 锚(§14.2.8 数据键)。
          dataVersion: summary.dataVersion ?? `${stepId}:${summary.candidateCount}`,
        });
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        if ((error as Error).name === "AbortError") return;
        setState({phase: "error", message: (error as Error).message || "读取失败"});
      }
    })();

    return () => controller.abort();
  }, [stepId, reloadToken]);

  const reload = useCallback(() => setReloadToken(token => token + 1), []);
  return {...state, reload};
}
