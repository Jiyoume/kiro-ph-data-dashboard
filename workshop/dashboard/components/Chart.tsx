'use client';

import dynamic from 'next/dynamic';

// Dynamic import with SSR disabled — Plotly needs DOM APIs
const Plot = dynamic(
  () => import('react-plotly.js').then(mod => mod.default),
  { ssr: false, loading: () => <div className="animate-pulse bg-slate-100 rounded-lg h-full" /> }
);

interface ChartProps {
  data: any[];
  layout?: Record<string, any>;
  className?: string;
}

export default function Chart({ data, layout, className }: ChartProps) {
  return (
    <div className={className}>
      <Plot
        data={data}
        layout={{
          autosize: true,
          font: { family: 'Inter, system-ui, sans-serif' },
          paper_bgcolor: 'white',
          plot_bgcolor: 'white',
          margin: { t: 60, r: 40, b: 50, l: 80 },
          ...layout,
        }}
        config={{
          responsive: true,
          displayModeBar: false,
        }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
