import { formatLocalDateTime, formatRelativeLocalTime } from "@/lib/local-time";

interface TreeNodeMetaProps {
  countLabel: string;
  endTime: string;
  nowMs?: number;
}

/** 统一展示树节点数量与最近更新时间，避免各层重复排版并保留语义化时间。 */
export function TreeNodeMeta({ countLabel, endTime, nowMs }: TreeNodeMetaProps) {
  return (
    <span className="tree-meta tree-node-meta">
      <span>{countLabel}</span>
      <time dateTime={endTime} title={formatLocalDateTime(endTime)}>
        {formatRelativeLocalTime(endTime, nowMs)}
      </time>
    </span>
  );
}
