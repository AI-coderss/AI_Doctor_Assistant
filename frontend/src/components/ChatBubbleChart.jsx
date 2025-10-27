// ChatBubbleChart.jsx
import React, { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';

export default function ChatBubbleChart({ config }) {
  const merged = useMemo(() => ({
    chart: {
      backgroundColor: 'transparent',
      height: 600,                     // ⬅️ TALL
      spacing: [16,16,16,16],
      ...(config.chart || {}),
    },
    title: {
      style: { fontSize: '18px', fontWeight: '700' },
      ...(config.title || {}),
    },
    plotOptions: {
      pie: {
        size: '100%',                  // ⬅️ FULL DIAMETER
        dataLabels: {
          distance: 14,
          style: { fontSize: '14px', fontWeight: '600' },
        },
        ...(config.plotOptions?.pie || {}),
      },
      ...(config.plotOptions || {}),
    },
    ...config,
  }), [config]);

  return (
    <div className="bubble-chart">
      <HighchartsReact highcharts={Highcharts} options={merged} />
    </div>
  );
}
