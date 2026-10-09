"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ConversationExportViewer,
  type ExportFilterData,
  type FilterOption,
  type ExportQueryNavigation,
} from "@/components/conversation-export-viewer";

export type { ExportFilterData, FilterOption };

function ExportPageContent({
  filterData,
  retentionDays,
}: {
  filterData: ExportFilterData;
  retentionDays?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const updateQuery = useCallback((query: string, navigation: ExportQueryNavigation) => {
    const href = query ? `/export?${query}` : "/export";
    if (navigation === "push") {
      router.push(href, { scroll: false });
      return;
    }
    router.replace(href, { scroll: false });
  }, [router]);

  return (
    <ConversationExportViewer
      mode="fullPage"
      initialQuery={searchParams.toString()}
      filterData={filterData}
      retentionDays={retentionDays}
      onQueryChange={updateQuery}
    />
  );
}

export function ExportContent({
  filterData,
  retentionDays,
}: {
  filterData: ExportFilterData;
  retentionDays?: number;
}) {
  return (
    <Suspense fallback={<div className="exp-empty">加载导出内容...</div>}>
      <ExportPageContent filterData={filterData} retentionDays={retentionDays} />
    </Suspense>
  );
}
