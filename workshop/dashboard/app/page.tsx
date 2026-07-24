import Chart from '@/components/Chart';
import NarrativeCard from '@/components/NarrativeCard';

// Import pre-generated chart JSONs
import layer1 from '@/public/charts/layer1_top_revenue.json';
import layer2 from '@/public/charts/layer2_segment_donut.json';
import layer3 from '@/public/charts/layer3_regional_treemap.json';
import layer4 from '@/public/charts/layer4_enterprise_exception.json';
import narrative from '@/public/charts/layer5_executive_narrative.json';

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      {/* Executive Narrative — top of page */}
      <NarrativeCard
        headline={narrative.headline}
        concentration={narrative.concentration}
        disparity={narrative.disparity}
        action={narrative.action}
        kpis={narrative.kpis}
      />

      {/* Charts grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Layer 1: Top Revenue */}
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <Chart
            data={layer1.data}
            layout={layer1.layout}
            className="h-[450px]"
          />
        </section>

        {/* Layer 2: Segment Donut */}
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <Chart
            data={layer2.data}
            layout={layer2.layout}
            className="h-[400px]"
          />
        </section>

        {/* Layer 3: Regional Treemap */}
        <section className="rounded-xl border bg-white p-5 shadow-sm lg:col-span-2">
          <Chart
            data={layer3.data}
            layout={layer3.layout}
            className="h-[450px]"
          />
        </section>

        {/* Layer 4: Enterprise Exception */}
        <section className="rounded-xl border bg-white p-5 shadow-sm lg:col-span-2">
          <Chart
            data={layer4.data}
            layout={layer4.layout}
            className="h-[450px]"
          />
        </section>
      </div>

      {/* Footer */}
      <footer className="border-t pt-4 text-center text-xs text-slate-400">
        Source: cleaned_dataset.parquet · Workshop PSCG 2024 · Powered by DuckDB + Plotly + Next.js
      </footer>
    </div>
  );
}
