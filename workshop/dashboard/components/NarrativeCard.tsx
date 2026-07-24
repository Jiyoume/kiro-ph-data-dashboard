interface NarrativeProps {
  headline: string;
  concentration: string;
  disparity: string;
  action: string;
  kpis: Record<string, string | number>;
}

export default function NarrativeCard({ headline, concentration, disparity, action, kpis }: NarrativeProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-6 shadow-sm">
      <h2 className="text-2xl font-bold text-slate-900">{headline}</h2>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Object.entries(kpis).map(([key, value]) => (
          <div key={key} className="rounded-lg bg-slate-100 px-3 py-2">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              {key.replace(/_/g, ' ')}
            </div>
            <div className="text-lg font-bold text-slate-800">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-600">
        <p><span className="font-semibold text-navy">Concentration:</span> {concentration}</p>
        <p><span className="font-semibold text-navy">Disparity:</span> {disparity}</p>
        <p><span className="font-semibold text-teal">Action:</span> {action}</p>
      </div>
    </div>
  );
}
