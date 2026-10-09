"use client";

/** Dashboard 图表的无依赖 SVG/HTML 组件；数据已由小时事实查询层做有界收敛。 */
export function DashboardTrendBars({values, labels = []}: {values: number[]; labels?: string[]}) {
  const max = Math.max(...values, 1);
  return (
    <div role="img" aria-label="Token 小时趋势" style={{display: "flex", alignItems: "end", gap: 8, height: 160}}>
      {values.map((value, index) => (
        <div key={`${labels[index] ?? index}`} title={labels[index]} style={{display: "grid", justifyItems: "center", gap: 4, flex: 1, height: "100%", alignItems: "end"}}>
          <i style={{display: "block", width: "100%", maxWidth: 32, minHeight: 4, height: `${Math.max(4, value / max * 100)}%`, borderRadius: "6px 6px 0 0", background: "var(--accent, #17885f)"}} />
          <small>{labels[index] ?? ""}</small>
        </div>
      ))}
    </div>
  );
}

export function DashboardDonut({segments, label}: {segments: Array<{value: number; color: string}>; label: string}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0) || 1;
  let cursor = 0;
  const stops = segments.map(segment => {
    const start = cursor / total * 100;
    cursor += Math.max(0, segment.value);
    return `${segment.color} ${start}% ${cursor / total * 100}%`;
  }).join(", ");
  return <div role="img" aria-label={label} style={{width: 148, height: 148, borderRadius: "50%", background: `conic-gradient(${stops})`, display: "grid", placeItems: "center"}}><span style={{width: 92, height: 92, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--surface, #fff)", fontSize: 12}}>{label}</span></div>;
}
