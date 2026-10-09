"use client";

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {buildNiceTicks} from "./chart-scale";
import {pad} from "./format";

/* ==================== 容器宽度自适应 ==================== */

function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function smoothPath(points: Array<[number, number]>): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)},${c2x.toFixed(1)} ${c2y.toFixed(1)},${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  /** 折线模式下首序列渲染面积填充。 */
  area?: boolean;
}

interface ChartFrameProps {
  width: number;
  height: number;
  ticks: number[];
  fmt: (value: number) => string;
  children: React.ReactNode;
  hover: React.ReactNode;
  onHover: (event: React.MouseEvent<SVGRectElement>, frame: ChartGeometry) => void;
  onLeave: () => void;
  frame: ChartGeometry;
}

interface ChartGeometry {
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  plotW: number;
  plotH: number;
  count: number;
}

function ChartFrame({width, height, ticks, fmt, children, hover, onHover, onLeave, frame}: ChartFrameProps) {
  const {padLeft, padRight, padTop, plotH, plotW} = frame;
  const yMax = ticks.at(-1) ?? 1;
  const gridLines = [];
  for (const [index, tick] of ticks.entries()) {
    const yy = padTop + (1 - tick / yMax) * plotH;
    gridLines.push(
      index > 0 ? (
        <line key={`grid-${index}`} x1={padLeft} y1={yy} x2={width - padRight} y2={yy} stroke="#e2e8f0" strokeWidth={1} strokeDasharray={index === ticks.length - 1 ? undefined : "4 4"} />
      ) : null,
      <text key={`label-${index}`} x={padLeft - 8} y={yy + 4} textAnchor="end" fontSize={11} fill="#94a3b8" style={{fontVariantNumeric: "tabular-nums"}}>
        {fmt(tick)}
      </text>,
    );
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      {gridLines}
      {children}
      {hover}
      <rect
        x={padLeft}
        y={padTop}
        width={plotW}
        height={plotH}
        fill="transparent"
        onMouseMove={event => onHover(event, frame)}
        onMouseLeave={onLeave}
      />
    </svg>
  );
}

/* ==================== 堆叠柱状图 ==================== */

export interface StackedBarChartProps {
  segments: ChartSeries[];
  fmt: (value: number) => string;
  axisFmt?: (value: number) => string;
  integerTicks?: boolean;
  titleAt: (index: number) => string;
  height?: number;
  /** 占比视图：每根柱归一化为 0-100% 展示构成；绝对量差距悬殊时仍能看清各段占比。 */
  share?: boolean;
}

export function StackedBarChart({segments, fmt, axisFmt, integerTicks = false, titleAt, height = 280, share = false}: StackedBarChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const count = segments[0]?.values.length ?? 0;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 10;
  const plotW = Math.max(0, width - padLeft - padRight);
  const plotH = height - padTop - padBottom;

  const totals = useMemo(() => {
    const result = new Array(count).fill(0);
    for (const segment of segments) {
      segment.values.forEach((value, index) => {
        result[index] += value;
      });
    }
    return result;
  }, [segments, count]);

  const ticks = useMemo(() => {
    if (share) return [0, 25, 50, 75, 100];
    let max = 0;
    for (const value of totals) max = Math.max(max, value);
    return buildNiceTicks(max, {integerOnly: integerTicks});
  }, [totals, integerTicks, share]);
  const yMax = ticks.at(-1) ?? 1;

  const barWidth = count > 0 ? Math.max(4, (plotW / count) * 0.65) : 0;
  const xAt = useCallback((index: number) => padLeft + (index + 0.5) * (plotW / Math.max(1, count)), [plotW, count]);
  const yAt = useCallback((value: number) => padTop + plotH - (value / yMax) * plotH, [padTop, plotH, yMax]);

  const onHover = useCallback((event: React.MouseEvent<SVGRectElement>, frame: ChartGeometry) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect || frame.count === 0) return;
    const x = event.clientX - rect.left;
    const index = Math.min(frame.count - 1, Math.max(0, Math.floor((x - frame.padLeft) / (frame.plotW / frame.count))));
    setHoverIndex(index);
  }, []);

  const onLeave = useCallback(() => setHoverIndex(null), []);

  const bars: React.ReactNode[] = [];
  for (let i = 0; i < count; i += 1) {
    let acc = 0;
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const value = segments[s].values[i] ?? 0;
      // 占比视图按该柱总量归一化；总量为 0 的柱不绘制。
      const magnitude = share ? (totals[i] > 0 ? (value / totals[i]) * 100 : 0) : value;
      const y = yAt(acc + magnitude);
      const h = yAt(acc) - yAt(acc + magnitude);
      bars.push(<rect key={`bar-${s}-${i}`} x={xAt(i) - barWidth / 2} y={y} width={barWidth} height={Math.max(0, h)} rx={3} fill={segments[s].color} opacity={0.9} />);
      acc += magnitude;
    }
  }

  const hoverX = hoverIndex === null ? 0 : xAt(hoverIndex);
  const resolvedAxisFmt = share ? (value: number) => `${Math.round(value)}%` : axisFmt ?? fmt;
  const tooltipValue = (index: number, segment: ChartSeries) => {
    const value = segment.values[index] ?? 0;
    if (!share) return fmt(value);
    const total = totals[index] ?? 0;
    const pct = total > 0 ? (value / total) * 100 : 0;
    return `${fmt(value)} · ${pct >= 0.1 ? pct.toFixed(1) : "<0.1"}%`;
  };

  return (
    <div ref={containerRef} style={{position: "relative", minHeight: height}}>
      {width > 0 ? (
        <ChartFrame
          width={width}
          height={height}
          ticks={ticks}
          fmt={resolvedAxisFmt}
          frame={{padLeft, padRight, padTop, padBottom, plotW, plotH, count}}
          onHover={onHover}
          onLeave={onLeave}
          hover={
            <g opacity={hoverIndex === null ? 0 : 1}>
              <line y1={padTop} y2={padTop + plotH} x1={hoverX} x2={hoverX} stroke="#64748b" strokeWidth={1} strokeDasharray="3 3" />
            </g>
          }
        >
          {bars}
        </ChartFrame>
      ) : null}
      {hoverIndex !== null ? (
        <div className="db-tooltip show" style={tooltipStyle(hoverX, width)}>
          <div className="db-tooltip-title">{titleAt(hoverIndex)}</div>
          {segments.map(segment => (
            <div key={segment.name} className="db-tooltip-row">
              <div className="db-tooltip-label"><span className="db-tooltip-dot" style={{background: segment.color}} />{segment.name}</div>
              <div className="db-tooltip-value">{tooltipValue(hoverIndex, segment)}</div>
            </div>
          ))}
          <div className="db-tooltip-divider" />
          <div className="db-tooltip-row">
            <div className="db-tooltip-label">{share ? "合计" : "合计"}</div>
            <div className="db-tooltip-value">{share ? "100%" : fmt(totals[hoverIndex] ?? 0)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** tooltip 定位：跟随悬停点，右侧越界时翻转到左侧。 */
function tooltipStyle(hoverX: number, containerWidth: number): React.CSSProperties {
  const flip = hoverX + 15 + 220 > containerWidth;
  return flip ? {left: Math.max(0, hoverX - 220), top: 20} : {left: hoverX + 15, top: 20};
}

/* ==================== 多序列折线图 ==================== */

export interface LineChartProps {
  segments: ChartSeries[];
  fmt: (value: number) => string;
  axisFmt?: (value: number) => string;
  integerTicks?: boolean;
  titleAt: (index: number) => string;
  height?: number;
}

export function LineChart({segments, fmt, axisFmt, integerTicks = false, titleAt, height = 280}: LineChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const count = segments[0]?.values.length ?? 0;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 10;
  const plotW = Math.max(0, width - padLeft - padRight);
  const plotH = height - padTop - padBottom;

  const ticks = useMemo(() => {
    let max = 0;
    for (const segment of segments) {
      for (const value of segment.values) max = Math.max(max, value);
    }
    return buildNiceTicks(max, {integerOnly: integerTicks});
  }, [segments, integerTicks]);
  const yMax = ticks.at(-1) ?? 1;

  const xAt = useCallback((index: number) => padLeft + (count <= 1 ? 0 : (index / (count - 1)) * plotW), [padLeft, plotW, count]);
  const yAt = useCallback((value: number) => padTop + plotH - (value / yMax) * plotH, [padTop, plotH, yMax]);

  const onHover = useCallback((event: React.MouseEvent<SVGRectElement>, frame: ChartGeometry) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect || frame.count === 0) return;
    const x = event.clientX - rect.left;
    const index = Math.min(frame.count - 1, Math.max(0, Math.round((x - frame.padLeft) / frame.plotW * (frame.count - 1))));
    setHoverIndex(index);
  }, []);

  const onLeave = useCallback(() => setHoverIndex(null), []);

  const areaSegment = segments.find(segment => segment.area);
  const gradientId = useMemo(() => `line-area-${Math.random().toString(36).slice(2, 9)}`, []);
  const hoverX = hoverIndex === null ? 0 : xAt(hoverIndex);

  return (
    <div ref={containerRef} style={{position: "relative", minHeight: height}}>
      {width > 0 ? (
        <ChartFrame
          width={width}
          height={height}
          ticks={ticks}
          fmt={axisFmt ?? fmt}
          frame={{padLeft, padRight, padTop, padBottom, plotW, plotH, count}}
          onHover={onHover}
          onLeave={onLeave}
          hover={
            <g opacity={hoverIndex === null ? 0 : 1}>
              <line y1={padTop} y2={padTop + plotH} x1={hoverX} x2={hoverX} stroke="#64748b" strokeWidth={1} strokeDasharray="3 3" />
              {segments.map(segment => {
                const value = hoverIndex === null ? 0 : segment.values[hoverIndex] ?? 0;
                return (
                  <g key={`hover-${segment.name}`}>
                    <circle cx={hoverX} cy={yAt(value)} r={7} fill={segment.color} opacity={0.15} />
                    <circle cx={hoverX} cy={yAt(value)} r={3.5} fill="white" stroke={segment.color} strokeWidth={2.5} />
                  </g>
                );
              })}
            </g>
          }
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={areaSegment?.color ?? "#10b981"} stopOpacity={0.25} />
              <stop offset="100%" stopColor={areaSegment?.color ?? "#10b981"} stopOpacity={0} />
            </linearGradient>
          </defs>
          {areaSegment ? (
            <path
              d={`${smoothPath(areaSegment.values.map((value, index) => [xAt(index), yAt(value)]))} L${xAt(count - 1)} ${padTop + plotH} L${padLeft} ${padTop + plotH} Z`}
              fill={`url(#${gradientId})`}
              stroke="none"
            />
          ) : null}
          {segments.map(segment => (
            <path
              key={segment.name}
              d={smoothPath(segment.values.map((value, index) => [xAt(index), yAt(value)]))}
              fill="none"
              stroke={segment.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </ChartFrame>
      ) : null}
      {hoverIndex !== null ? (
        <div className="db-tooltip show" style={tooltipStyle(hoverX, width)}>
          <div className="db-tooltip-title">{titleAt(hoverIndex)}</div>
          {segments.map(segment => (
            <div key={segment.name} className="db-tooltip-row">
              <div className="db-tooltip-label"><span className="db-tooltip-dot" style={{background: segment.color}} />{segment.name}</div>
              <div className="db-tooltip-value">{fmt(segment.values[hoverIndex] ?? 0)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ==================== 环形占比图 ==================== */

export interface DonutDatum {
  name: string;
  value: number;
  color: string;
}

interface DonutCallout extends DonutDatum {
  index: number;
  percent: string;
  displayValue: string;
  side: "left" | "right";
  anchorY: number;
  sin: number;
  cos: number;
}

interface DonutConnector {
  color: string;
  path: string;
  anchorX: number;
  anchorY: number;
}

interface DonutConnectorLayer {
  width: number;
  height: number;
  connectors: DonutConnector[];
}

const donutSegmentGap = 3;

/**
 * 将环段标注分配到左右两条信息车道，并按环体锚点排序。
 * 这里只处理已经由 SQLite/API 限流后的图表数据，不读取 Raw，也不改变统计口径。
 */
function placeDonutCallouts(items: DonutCallout[], height: number, minGap: number): DonutCallout[] {
  const grouped: Record<DonutCallout["side"], DonutCallout[]> = {left: [], right: []};
  for (const item of items) grouped[item.side].push(item);
  const result: DonutCallout[] = [];
  for (const side of ["left", "right"] as const) {
    const group = grouped[side].sort((left, right) => left.anchorY - right.anchorY);
    let previousY = Number.NEGATIVE_INFINITY;
    for (const item of group) {
      const nextY = Math.max(24, Math.min(height - 24, Math.max(item.anchorY, previousY + minGap)));
      result.push({...item, anchorY: nextY});
      previousY = nextY;
    }
  }
  return result;
}

/** 从环段外缘沿法向向外鼓出，再以水平切线收束到文案，整条路径不穿过环体。 */
function buildDonutConnectorPath(
  anchorX: number,
  anchorY: number,
  endX: number,
  endY: number,
  side: DonutCallout["side"],
  normalX: number,
  normalY: number,
): string {
  const direction = side === "right" ? 1 : -1;
  const horizontalDistance = Math.abs(endX - anchorX);
  const verticalDistance = Math.abs(endY - anchorY);
  const outwardDistance = Math.min(96, Math.max(44, 44 + verticalDistance * 0.28));
  const sidePull = 20;
  const approachDistance = Math.min(72, Math.max(28, horizontalDistance * 0.24));
  const rawOutwardControlX = anchorX + normalX * outwardDistance + direction * sidePull;
  const outwardControlY = anchorY + normalY * outwardDistance;
  const approachControlX = endX - direction * approachDistance;
  // 控制点保持在终点控制点之前，避免短距离、多标注场景出现横向回折或相互交叉。
  const outwardControlX = direction === 1
    ? Math.min(rawOutwardControlX, approachControlX - 4)
    : Math.max(rawOutwardControlX, approachControlX + 4);
  return `M ${anchorX.toFixed(1)} ${anchorY.toFixed(1)} C ${outwardControlX.toFixed(1)} ${outwardControlY.toFixed(1)}, ${
    approachControlX.toFixed(1)
  } ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
}

export function Donut({
  data,
  centerValue,
  centerLabel,
  fmt,
  hrefFor,
  valueAt,
  width = 520,
  height = 320,
}: {
  data: DonutDatum[];
  centerValue: string;
  centerLabel: string;
  fmt: (value: number) => string;
  /** 每段标注的溯源链接（与图例点击一致）；缺省时标注不可点击。 */
  hrefFor?: (name: string) => string;
  /** 引线标注第二行的自定义文案（如按名称展示单位成本）；缺省回落 fmt(value)。 */
  valueAt?: (datum: DonutDatum) => string;
  /** 逻辑画布尺寸：用于计算标注车道，不直接限制外层容器宽度。 */
  width?: number;
  height?: number;
}) {
  /* 环体为标注车道让出稳定宽度：桌面侧栏优先保证模型/供应商、百分比与金额完整可读。 */
  const ringSize = Math.min(224, Math.max(176, Math.round(Math.min(width, height) * 0.72)));
  const cx = ringSize / 2;
  const cy = ringSize / 2;
  const strokeWidth = 22;
  const radius = ringSize / 2 - strokeWidth - 10;
  const total = useMemo(() => data.reduce((acc, datum) => acc + datum.value, 0), [data]);
  const circumference = 2 * Math.PI * radius;
  const placedCallouts = useMemo(() => {
    const callouts: DonutCallout[] = [];
    if (total <= 0) return callouts;
    let accFraction = 0;
    data.forEach((datum, index) => {
      const fraction = datum.value / total;
      // 环段末尾会留出固定像素间隔，小环段必须按实际可见色段取中点，否则锚点会落在分隔缝里。
      const visibleFraction = Math.max(0, fraction - donutSegmentGap / circumference);
      const midDeg = (accFraction + visibleFraction / 2) * 360;
      const rad = midDeg * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      callouts.push({
        ...datum,
        index,
        percent: `${(fraction * 100).toFixed(1)}%`,
        displayValue: valueAt ? valueAt(datum) : fmt(datum.value),
        side: sin >= 0 ? "right" : "left",
        anchorY: height / 2 - cos * (height / 2 - 24),
        sin,
        cos,
      });
      accFraction += fraction;
    });
    return placeDonutCallouts(callouts, height, Math.max(38, Math.round(height / 7)));
  }, [circumference, data, fmt, height, total, valueAt]);
  const leftCallouts = placedCallouts.filter(item => item.side === "left");
  const rightCallouts = placedCallouts.filter(item => item.side === "right");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ringSvgRef = useRef<SVGSVGElement | null>(null);
  const [connectorLayer, setConnectorLayer] = useState<DonutConnectorLayer>({width: 0, height: 0, connectors: []});

  /* 文案会随容器宽度换行，必须以最终 DOM 坐标连接，不能再用固定长度装饰线冒充引线。 */
  useLayoutEffect(() => {
    const wrapper = wrapRef.current;
    const ringSvg = ringSvgRef.current;
    if (!wrapper || !ringSvg || placedCallouts.length === 0) {
      setConnectorLayer({width: 0, height: 0, connectors: []});
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const wrapperRect = wrapper.getBoundingClientRect();
        const ringRect = ringSvg.getBoundingClientRect();
        const scaleX = ringRect.width / ringSize;
        const scaleY = ringRect.height / ringSize;
        const anchorRadius = radius + strokeWidth / 2 + 1;
        const connectors = placedCallouts.flatMap(callout => {
          const endpoint = wrapper.querySelector<HTMLElement>(`[data-donut-callout="${callout.index}"] .donut-callout-anchor`);
          if (!endpoint) return [];
          const endpointRect = endpoint.getBoundingClientRect();
          const anchorX = ringRect.left - wrapperRect.left + (cx + anchorRadius * callout.sin) * scaleX;
          const anchorY = ringRect.top - wrapperRect.top + (cy - anchorRadius * callout.cos) * scaleY;
          const scaledNormalX = callout.sin * scaleX;
          const scaledNormalY = -callout.cos * scaleY;
          const normalLength = Math.hypot(scaledNormalX, scaledNormalY) || 1;
          const normalX = scaledNormalX / normalLength;
          const normalY = scaledNormalY / normalLength;
          const endX = (callout.side === "right" ? endpointRect.left : endpointRect.right) - wrapperRect.left;
          const endY = endpointRect.top - wrapperRect.top + endpointRect.height / 2;
          return [{
            color: callout.color,
            path: buildDonutConnectorPath(anchorX, anchorY, endX, endY, callout.side, normalX, normalY),
            anchorX,
            anchorY,
          }];
        });
        const next = {
          width: Math.max(1, wrapperRect.width),
          height: Math.max(1, wrapperRect.height),
          connectors,
        };
        setConnectorLayer(current =>
          current.width === next.width
          && current.height === next.height
          && current.connectors.length === next.connectors.length
          && current.connectors.every((connector, index) => connector.path === next.connectors[index]?.path)
            ? current
            : next,
        );
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    observer.observe(ringSvg);
    for (const endpoint of wrapper.querySelectorAll<HTMLElement>(".donut-callout-anchor")) observer.observe(endpoint);
    void document.fonts?.ready.then(update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [cx, cy, placedCallouts, radius, ringSize]);

  let accFraction = 0;
  const renderCallout = (callout: DonutCallout) => {
    const content = (
      <>
        <span className="donut-callout-connector donut-callout-anchor" style={{background: callout.color}} aria-hidden="true" />
        <span className="donut-callout-copy" title={`${callout.name} ${callout.percent} ${callout.displayValue}`}>
          <strong className="donut-callout-name">{callout.name} <em className="donut-callout-percent">{callout.percent}</em></strong>
          <small className="donut-callout-value">{callout.displayValue}</small>
        </span>
      </>
    );
    const className = `donut-callout-item donut-callout-${callout.side}`;
    return hrefFor
      ? <a key={callout.index} data-donut-callout={callout.index} href={hrefFor(callout.name)} className={className} title={`查看${callout.name}请求明细`}>{content}</a>
      : <div key={callout.index} data-donut-callout={callout.index} className={className}>{content}</div>;
  };

  return (
    <div ref={wrapRef} className="donut-callout-wrap">
      {connectorLayer.connectors.length > 0 ? (
        <svg
          className="donut-callout-lines"
          width={connectorLayer.width}
          height={connectorLayer.height}
          viewBox={`0 0 ${connectorLayer.width} ${connectorLayer.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {connectorLayer.connectors.map((connector, index) => (
            <g key={index}>
              <path d={connector.path} fill="none" stroke={connector.color} strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <circle cx={connector.anchorX} cy={connector.anchorY} r={2.2} fill={connector.color} />
            </g>
          ))}
        </svg>
      ) : null}
      <div className="donut-callout-column donut-callout-left" aria-label="左侧环图标注">
        {leftCallouts.map(renderCallout)}
      </div>
      <div className="donut-ring-core">
      <svg ref={ringSvgRef} className="donut-ring-svg" width={ringSize} height={ringSize} viewBox={`0 0 ${ringSize} ${ringSize}`} role="img" aria-label={centerLabel}>
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
        {total > 0 ? data.map(datum => {
          const fraction = datum.value / total;
          const dash = Math.max(0, fraction * circumference - donutSegmentGap);
          const element = (
            <circle
              key={datum.name}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={datum.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-accFraction * circumference}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          accFraction += fraction;
          return element;
        }) : null}
      </svg>
      <div className="donut-center-overlay">
        <strong>{centerValue}</strong>
        <span>{centerLabel}</span>
      </div>
      </div>
      <div className="donut-callout-column donut-callout-right" aria-label="右侧环图标注">
        {rightCallouts.map(renderCallout)}
      </div>
    </div>
  );
}

/* ==================== 迷你趋势线 ==================== */

export function Sparkline({values, color, height = 48}: {values: number[]; color: string; height?: number}) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  if (values.length === 0 || width <= 0) {
    return <div ref={containerRef} className="kpi-sparkline" style={{height}} />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((value, index): [number, number] => [
    (index / Math.max(1, values.length - 1)) * width,
    height - 5 - ((value - min) / range) * (height - 10),
  ]);
  return (
    <div ref={containerRef} className="kpi-sparkline" style={{height}}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <path d={smoothPath(points)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/* ==================== X 轴标签 ==================== */

export function XLabels({count, labelAt, showAll = false}: {count: number; labelAt: (index: number) => string; showAll?: boolean}) {
  const indices = useMemo(() => {
    if (count <= 0) return new Set<number>();
    if (showAll || count <= 8) return new Set(Array.from({length: count}, (_, i) => i));
    const picks = new Set<number>();
    for (let i = 0; i < 7; i += 1) picks.add(Math.round((i / 6) * (count - 1)));
    return picks;
  }, [count, showAll]);
  return (
    <div className="chart-x-labels" aria-hidden="true">
      {Array.from({length: count}, (_, index) => (
        <span key={index} className="chart-x-label">{indices.has(index) ? labelAt(index) : ""}</span>
      ))}
    </div>
  );
}

/** 小时桶轴标签：HH；日桶：MM-DD（由调用方传入键）。 */
export function hourLabel(index: number): string {
  return pad(index);
}
