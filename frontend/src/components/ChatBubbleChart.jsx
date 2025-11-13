// ChatBubbleChart.jsx
import React, { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';

// ✅ Enable modules that many of your configs use
import HighchartsMore from 'highcharts/highcharts-more';         // needed for 'bubble'
import Exporting from 'highcharts/modules/exporting';            // optional but handy
import Accessibility from 'highcharts/modules/accessibility';    // optional

HighchartsMore(Highcharts);
Exporting(Highcharts);
Accessibility(Highcharts);

export default function ChatBubbleChart({ config }) {
  // Defensive normalize → keep your pie defaults, but gracefully accept other types too
  const merged = useMemo(() => {
    const base = {
      chart: {
        backgroundColor: 'transparent',
        height: 600,                    // tall chart
        spacing: [16, 16, 16, 16],
      },
      title: {
        style: { fontSize: '18px', fontWeight: '700' },
      },
      plotOptions: {
        pie: {
          size: '100%',
          dataLabels: {
            distance: 14,
            style: { fontSize: '14px', fontWeight: '600' },
          },
        },
      },
      credits: { enabled: false },
      exporting: { enabled: false },
    };

    // Merge user config last so your backend pie config wins,
    // but bubble/others also work if intentionally passed.
    const out = {
      ...base,
      ...(config || {}),
      chart: { ...base.chart, ...(config?.chart || {}) },
      title: { ...base.title, ...(config?.title || {}) },
      plotOptions: {
        ...base.plotOptions,
        ...(config?.plotOptions || {}),
        pie: { ...base.plotOptions.pie, ...(config?.plotOptions?.pie || {}) },
      },
    };

    return out;
  }, [config]);

  return (
    <div className="bubble-chart">
      <HighchartsReact highcharts={Highcharts} options={merged} />
    </div>
  );
}
