'use client';

interface SparkChartProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  showArea?: boolean;
}

export function SparkChart({ data, width = 200, height = 40, color = '#10b981', showArea = true }: SparkChartProps) {
  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * width,
    y: height - ((v - min) / range) * (height - 4) - 2,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {showArea && <path d={areaPath} fill={color} opacity={0.1} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2} fill={color} />
    </svg>
  );
}
