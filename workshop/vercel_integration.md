# Vercel / Next.js Integration — Workshop Reference

## How to render Plotly JSON in a production Next.js dashboard

Each Python script exports a `charts/*.json` file containing the full Plotly figure spec. Here's how to consume them in a Vercel-deployed Next.js app:

---

### 1. Install the Plotly React wrapper

```bash
npm install react-plotly.js plotly.js-dist-min
```

### 2. Create a reusable `<Chart />` component

```tsx
// components/Chart.tsx
'use client';

import dynamic from 'next/dynamic';
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface ChartProps {
  data: any;
  layout?: any;
  style?: React.CSSProperties;
}

export default function Chart({ data, layout, style }: ChartProps) {
  return (
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
        displayModeBar: false,  // Clean look for execs
      }}
      style={{ width: '100%', height: '100%', ...style }}
      useResizeHandler
    />
  );
}
```

### 3. Load a chart JSON in a page

```tsx
// app/dashboard/page.tsx
import Chart from '@/components/Chart';
import layer1Data from '@/public/charts/layer1_top_revenue.json';

export default function DashboardPage() {
  return (
    <main className="grid grid-cols-1 md:grid-cols-2 gap-6 p-8">
      {/* Layer 1: Top Revenue Contributors */}
      <section className="bg-white rounded-xl border p-6 shadow-sm">
        <Chart
          data={layer1Data.data}
          layout={layer1Data.layout}
          style={{ height: 450 }}
        />
      </section>

      {/* Layer 5: Executive Narrative Card */}
      <section className="bg-slate-50 rounded-xl border p-6">
        <h2 className="text-2xl font-bold text-slate-800">
          {narrative.headline}
        </h2>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">
          {narrative.concentration}
        </p>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          {narrative.action}
        </p>
      </section>
    </main>
  );
}
```

### 4. Deploy to Vercel

```bash
npx vercel --prod
```

The `public/charts/*.json` files are served as static assets. No API routes needed — Plotly renders entirely client-side from the pre-computed JSON.

---

### Pro tip: DuckDB-WASM live queries

For interactive filtering (e.g., year slider, region dropdown), load `cleaned_dataset.parquet` into DuckDB-WASM in the browser and query it directly — exactly as we did in the BIR dashboard earlier. The Plotly JSON approach above is best for static executive reports; DuckDB-WASM is best for interactive drill-down.
